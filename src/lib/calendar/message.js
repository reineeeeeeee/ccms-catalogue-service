import { isValidManilaDate } from 'ccms-shared';
import { occurrencesInRange } from './engine/recurrence.js';

// Calendar message cal-1.0 (FMS contract, locked by FMS 10/30/2026). This file is the ONLY place that decides what a
// calendar message looks like. The envelope names below come from the contract text we were given:
//   messageId, schemaVersion "cal-1.0", entityId, entityRevision, changeKind UPSERT | REMOVE,
//   appliesTo, interval { start, end, allDay }, effect, mode.
// The remaining names (entryType, date, description, officeId) are PROPOSED: they were not named in the task text.
// If the FMS document names them differently, change them here and nowhere else.

export const SCHEMA_VERSION = 'cal-1.0';
export const CHANGE_KIND = Object.freeze({ UPSERT: 'UPSERT', REMOVE: 'REMOVE' });

/** WORK -> ["WORK"], CLASSES -> ["CLASSES"], BOTH -> ["CLASSES","WORK"]. Never missing. */
const APPLIES_TO = Object.freeze({ WORK: ['WORK'], CLASSES: ['CLASSES'], BOTH: ['CLASSES', 'WORK'] });
export const appliesToList = (appliesTo) => [...(APPLIES_TO[appliesTo] ?? APPLIES_TO.BOTH)];

/** Thrown when a part-day entry has a start but no end: such an entry is never sent (EB4). */
export class IncompleteEntryError extends Error {
  constructor(entryId) {
    super('A part-day calendar entry needs both a start and an end time');
    this.name = 'IncompleteEntryError';
    this.code = 'CALENDAR_ENTRY_INCOMPLETE';
    this.entryId = entryId;
  }
}

// Recurring entries are sent as one dated entry per date (FMS scenario 3). Which dates: the pull range FMS gave us
// (2026-08-17 to 2026-12-12) unless CAL_WINDOW_FROM / CAL_WINDOW_TO say otherwise. PM to confirm the horizon.
export const DEFAULT_WINDOW = Object.freeze({ from: '2026-08-17', to: '2026-12-12' });

export function calendarWindow(env = process.env) {
  const from = env.CAL_WINDOW_FROM;
  const to = env.CAL_WINDOW_TO;
  const ok = isValidManilaDate(from ?? '') && isValidManilaDate(to ?? '') && from <= to;
  return ok ? { from, to } : { ...DEFAULT_WINDOW };
}

/** EB5 switch (default OFF): while off, `effect` and ONLINE entries are not sent to FMS. */
export const effectEnabled = (env = process.env) => String(env.CAL_EFFECT_ENABLED ?? '').toLowerCase() === 'true';

const affectsClasses = (entry) => entry.applies_to !== 'WORK';

/** Whether FMS may receive this entry now (EB5 AC1: with the switch off an ONLINE entry is not sent, SUSPENDED is). */
export const sendableToFms = (entry, effectOn) => effectOn || !(affectsClasses(entry) && entry.class_mode === 'ONLINE');

/** The dates an entry produces messages for: its own date, or every occurrence inside the window when recurring. */
export function occurrenceDates(entry, window) {
  return entry.is_recurring ? occurrencesInRange(entry, window.from, window.to) : [entry.exception_date];
}

/** Id of one dated entry: the entry's own ID, or "<id>@<date>" for each date of a recurring entry. */
export const entityIdOf = (entry, date) => (entry.is_recurring ? `${entry.exception_id}@${date}` : entry.exception_id);

/** { start, end, allDay } in Asia/Manila (+08:00). A whole day is 00:00 to 24:00; a part day needs both times. */
export function intervalOf(entry, date) {
  if (!entry.suspended_from) {
    return { start: `${date}T00:00:00+08:00`, end: `${date}T24:00:00+08:00`, allDay: true };
  }
  if (!entry.suspended_until) throw new IncompleteEntryError(entry.exception_id);
  return {
    start: `${date}T${entry.suspended_from}:00+08:00`,
    end: `${date}T${entry.suspended_until}:00+08:00`,
    allDay: false,
  };
}

/**
 * One cal-1.0 body (no messageId: the pull route sends it without one, the push adds it).
 * `effect` appears only while the switch is on; it carries a value only when classes are affected and the entry is
 * campus-wide (C42), otherwise null. `mode` is always null ("all classes").
 * A REMOVE of an entry that never had a valid interval carries interval null (identity is all the receiver needs).
 */
export function buildEntry({ entry, date, changeKind, effectOn }) {
  let interval = null;
  try {
    interval = intervalOf(entry, date);
  } catch (err) {
    if (!(err instanceof IncompleteEntryError) || changeKind !== CHANGE_KIND.REMOVE) throw err;
  }
  const body = {
    schemaVersion: SCHEMA_VERSION,
    entityId: entityIdOf(entry, date),
    entityRevision: entry.revision,
    changeKind,
    entryType: entry.exception_type,
    date,
    description: entry.description ?? '',
    officeId: entry.office_id ?? null,
    appliesTo: appliesToList(entry.applies_to),
    interval,
    mode: null,
  };
  if (effectOn) body.effect = affectsClasses(entry) && !entry.office_id ? entry.class_mode : null;
  return body;
}

/** The push message: the entry body plus the unique messageId (the sync row's own ID, so every retry repeats it). */
export const buildMessage = ({ messageId, ...rest }) => ({ messageId, ...buildEntry(rest) });
