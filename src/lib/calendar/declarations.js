import { Errors, isValidManilaDate } from 'ccms-shared';
import { CalendarException } from '../entities/index.js';
import { toExceptionDto } from './exceptions.js';
import { dayIndexOfDate, MAX_SPAN_DAYS } from './engine/working-time.js';
import { occurrencesInRange } from './engine/recurrence.js';
import { CHANGE_KIND, IncompleteEntryError, SCHEMA_VERSION, buildEntry, effectEnabled, sendableToFms } from './message.js';

// EB6: the snapshot FMS pulls to recover after an outage or a missed message.
//   GET /declarations?from=&to=&cursor=&limit=     (the Gateway shows it as /calendar/declarations)
// Every entry that falls in the range, removals (tombstones) included, in the same shape as a pushed message but without a
// messageId (a pull is not a message). A recurring entry gives one dated entry per date. The list is ordered by
// (date, entityId) and cut into pages with an opaque cursor, so a full read returns each entry exactly once.
//
// PROPOSAL for FMS (we owe them this): default page size 100, at most 500 (limit=). The response carries nextCursor, which is
// null on the last page; send it back unchanged as ?cursor=. A cursor only means "everything after this entry", so entries
// added while paging are never skipped past, and an entry changed while paging may appear at its new place.

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

const encodeCursor = (item) => Buffer.from(JSON.stringify([item.date, item.entityId]), 'utf8').toString('base64url');

function decodeCursor(value) {
  const bad = () => Errors.validation('cursor is not valid', { cursor: 'cursor is not valid' });
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw bad();
    return parsed;
  } catch (err) {
    throw err?.status ? err : bad();
  }
}

function dateParam(value, name) {
  if (typeof value !== 'string' || !isValidManilaDate(value)) {
    throw Errors.validation(`${name} must be a date (YYYY-MM-DD)`, { [name]: `${name} must be a date (YYYY-MM-DD)` });
  }
  return value;
}

export function parseDeclarationQuery(query) {
  const from = dateParam(query.from, 'from');
  const to = dateParam(query.to, 'to');
  if (from > to) throw Errors.validation('from must not be after to', { from: 'from must not be after to' });
  if (dayIndexOfDate(to) - dayIndexOfDate(from) > MAX_SPAN_DAYS) {
    throw Errors.validation(`The range must not be longer than ${MAX_SPAN_DAYS} days`, { to: 'Range is too long' });
  }
  let limit = DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw Errors.validation(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`, { limit: `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}` });
    }
  }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  return { from, to, limit, cursor };
}

/** The whole snapshot of the range, ordered, before paging. Exposed for tests and the readiness report. */
export async function buildDeclarations(dataSource, { from, to }, env = process.env) {
  const effectOn = effectEnabled(env);
  const rows = await dataSource.getRepository(CalendarException).find();
  const items = [];
  const incomplete = [];
  for (const row of rows) {
    const entry = toExceptionDto(row);
    const removed = row.removedAt != null;
    if (!sendableToFms(entry, effectOn)) continue;
    for (const date of occurrencesInRange(entry, from, to)) {
      try {
        items.push(buildEntry({ entry, date, changeKind: removed ? CHANGE_KIND.REMOVE : CHANGE_KIND.UPSERT, effectOn }));
      } catch (err) {
        if (!(err instanceof IncompleteEntryError)) throw err;
        incomplete.push(entry.exception_id);
      }
    }
  }
  if (incomplete.length) {
    // A part-day entry without an end time is never sent (EB4). The read fails loudly instead of leaving it out silently.
    throw Errors.conflict('Some part-day calendar entries have no end time yet', 'CALENDAR_ENTRY_INCOMPLETE', { entry_ids: [...new Set(incomplete)] });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.entityId.localeCompare(b.entityId));
  return items;
}

export async function listDeclarations(dataSource, query, env = process.env) {
  const { from, to, limit, cursor } = parseDeclarationQuery(query);
  const all = await buildDeclarations(dataSource, { from, to }, env);
  const after = cursor ? all.filter((item) => item.date > cursor[0] || (item.date === cursor[0] && item.entityId > cursor[1])) : all;
  const page = after.slice(0, limit);
  const last = page.length ? page[page.length - 1] : null;
  return { schemaVersion: SCHEMA_VERSION, from, to, items: page, nextCursor: after.length > limit && last ? encodeCursor(last) : null };
}
