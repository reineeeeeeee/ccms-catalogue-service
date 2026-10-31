import { randomUUID } from 'node:crypto';
import { Errors, isUuid, isValidManilaDate } from 'ccms-shared';

export const EXCEPTION_TYPES = Object.freeze(['REGULAR_HOLIDAY', 'SPECIAL_NON_WORKING', 'SUSPENSION', 'LOCAL_HOLIDAY']);

export const MSG = Object.freeze({
  CLOSING_AFTER_OPENING: 'Closing time must be after opening time',
  ONE_WORKING_DAY: 'At least one working day is required',
  ENTRY_EXISTS: 'An entry already exists for this date and scope',
  SUSPENSION_NOT_RECURRING: 'Suspensions cannot be recurring',
  TERM_OVERLAP: 'Term dates overlap an existing term',
  TERM_END_AFTER_START: 'End date must be after start date',
  END_AFTER_START: 'End must be after start',
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (value) => typeof value === 'string' && TIME_RE.test(value);

/** Serialises calendar writes so the application checks (overlaps, recurring dates) cannot race. */
export async function lockCalendar(manager) {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ccms-calendar-write']);
}

export const newId = () => randomUUID();

/** Optional text: undefined, null and '' all mean "empty". */
export function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined; // caller reports the type error
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function requireDate(value, field, label, details) {
  if (typeof value !== 'string' || !isValidManilaDate(value.trim())) {
    details[field] = `${label} must be a valid date (YYYY-MM-DD)`;
    return null;
  }
  return value.trim();
}

export function parseOptionalUuid(value, field, label) {
  const text = optionalText(value);
  if (text === undefined || (text !== null && !isUuid(text))) {
    throw Errors.validation(`${label} must be a valid ID`, { [field]: `${label} must be a valid ID` });
  }
  return text;
}
