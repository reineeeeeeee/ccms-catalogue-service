import { randomUUID } from 'node:crypto';
import { CalendarException } from '../entities/index.js';
import { toExceptionDto } from './exceptions.js';
import { occurrencesInRange } from './engine/recurrence.js';
import { IncompleteEntryError, CHANGE_KIND, buildEntry } from './message.js';

// EB17: the term snapshot for SMS. SMS has NOT confirmed its field or type names yet, so everything SMS-specific is in this
// file and marked PROPOSED. Nothing leaves CCMS while SMS_SYNC_ENABLED is off (the SMS queue is the legacy consumer "AUDIT").
//
// What a snapshot is: the full state of one term, not a change. It lists every live entry (regular holiday, special
// non-working day, local holiday, suspension) that falls in the term's dates, each with appliesTo (WORK / CLASSES / BOTH
// as a list) and its interval (part-day suspensions carry start and end, EB4). A withdrawn entry is simply absent from the
// next snapshot. PROPOSED: SMS question 1 ("how is a withdrawn entry shown") is still open.
// Ordering: a new snapshot for a term supersedes any older one that has not been delivered yet, so SMS never receives
// an older snapshot after a newer one. `syncId` is stable across retries; SMS can drop a repeated syncId.

export const SNAPSHOT_ENTITY_TYPE = 'term_snapshot';
export const SMS_CONSUMER = 'AUDIT';

/** Our entry types -> the four SMS types. PROPOSED names: replace the right-hand side when SMS confirms them. */
export const SMS_TYPE_MAP = Object.freeze({
  REGULAR_HOLIDAY: 'REGULAR_HOLIDAY',
  SPECIAL_NON_WORKING: 'SPECIAL_NON_WORKING_DAY',
  LOCAL_HOLIDAY: 'LOCAL_HOLIDAY',
  SUSPENSION: 'SUSPENSION',
});

/**
 * Term code. It comes from SMS once EB18 exists. Until then a TEST value is used: the term name. (PROPOSED)
 */
export const termCodeOf = (term) => term.term_name;

const toItem = (body) => ({
  entityId: body.entityId,
  entityRevision: body.entityRevision,
  type: SMS_TYPE_MAP[body.entryType] ?? body.entryType,
  date: body.date,
  description: body.description,
  officeId: body.officeId,
  appliesTo: body.appliesTo,
  interval: body.interval,
  effect: body.effect ?? null,
});

/** Builds the snapshot of one term from the live entries. Part-day entries without an end time are listed under `skipped`. */
export async function buildTermSnapshot(manager, term, { syncId = randomUUID(), now = new Date() } = {}) {
  const rows = await manager.getRepository(CalendarException).find();
  const items = [];
  const skipped = [];
  for (const row of rows) {
    if (row.removedAt != null) continue;
    const entry = toExceptionDto(row);
    for (const date of occurrencesInRange(entry, term.start_date, term.end_date)) {
      try {
        items.push(toItem(buildEntry({ entry, date, changeKind: CHANGE_KIND.UPSERT, effectOn: true })));
      } catch (err) {
        if (!(err instanceof IncompleteEntryError)) throw err;
        skipped.push(entry.exception_id);
      }
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.entityId.localeCompare(b.entityId));
  return {
    syncId,
    kind: SNAPSHOT_ENTITY_TYPE,
    termCode: termCodeOf(term),
    termName: term.term_name,
    from: term.start_date,
    to: term.end_date,
    generatedAt: now.toISOString(),
    items,
    skipped: [...new Set(skipped)],
  };
}

const loadTerms = (manager) =>
  manager.query('SELECT term_id, term_name, start_date::text AS start_date, end_date::text AS end_date FROM term_dates ORDER BY start_date');

/** Queues one snapshot for one term. Older undelivered snapshots of the same term are marked SUPERSEDED. */
export async function enqueueTermSnapshot(manager, term) {
  const payload = await buildTermSnapshot(manager, term);
  await manager.query(
    `UPDATE sync_log SET status = 'SUPERSEDED'
      WHERE consumer_system = $1 AND entity_type = $2 AND entity_id = $3 AND status IN ('PENDING', 'FAILED')`,
    [SMS_CONSUMER, SNAPSHOT_ENTITY_TYPE, payload.termCode],
  );
  await manager.query(
    `INSERT INTO sync_log (sync_id, consumer_system, event_type, entity_type, entity_id, payload, status)
     VALUES ($1, $2, 'TERM_SNAPSHOT', $3, $4, $5::jsonb, 'PENDING')`,
    [payload.syncId, SMS_CONSUMER, SNAPSHOT_ENTITY_TYPE, payload.termCode, JSON.stringify(payload)],
  );
  return payload;
}

/**
 * Called inside the transaction of a calendar-entry change (added, corrected or withdrawn). Queues a new snapshot for
 * every term that the entry, before or after the change, falls in.
 */
export async function enqueueAffectedSnapshots(manager, { entry, previous = null }) {
  const terms = await loadTerms(manager);
  const queued = [];
  for (const term of terms) {
    const touches = (value) => value && occurrencesInRange(value, term.start_date, term.end_date).length > 0;
    if (touches(entry) || touches(previous)) queued.push(await enqueueTermSnapshot(manager, term));
  }
  return queued;
}

/** Reads the SMS reply to a snapshot. PROPOSED shape: { status: 'SUCCESS' | 'FAILED', termId, applied: {...}, reason }. */
export function interpretReply(body) {
  if (!body || typeof body !== 'object') return { ok: true, reply: null };
  const status = String(body.status ?? '').toUpperCase();
  if (status === 'FAILED' || status === 'FAILURE' || status === 'ERROR' || body.success === false) {
    return { ok: false, reply: body, reason: String(body.reason ?? body.message ?? 'SMS rejected the snapshot') };
  }
  return { ok: true, reply: body };
}
