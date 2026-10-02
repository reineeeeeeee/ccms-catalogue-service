import { Errors, isUuid, isValidManilaDate } from 'ccms-shared';
import { MSG, optionalText } from './calendar-rules.js';
import {
  EngineError,
  computeDeadline,
  computeWorkingMinutes,
  createCalendar,
  describeDay,
  formatManilaIso,
} from './engine/working-time.js';
import { loadEngineEntries } from './exceptions.js';
import { readSchedule } from './schedule.js';

// An ISO-8601 timestamp must carry its own offset: without one the parser would read it in the
// server's local time zone, and results would change with the server clock.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

export function parseInstant(value, field, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  const ms = ISO_WITH_OFFSET.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) {
    const message = `${label} must be an ISO timestamp with a time zone offset, for example 2026-10-06T10:00:00+08:00`;
    throw Errors.validation(message, { [field]: message });
  }
  return ms;
}

export function parseEngineOfficeId(value) {
  const text = optionalText(value);
  if (text === undefined || (text !== null && !isUuid(text))) {
    throw Errors.validation('officeId must be a valid ID', { officeId: 'officeId must be a valid ID' });
  }
  return text;
}

/** Loads the schedule and the office's entries, and builds the pure engine's calendar. */
export async function loadCalendar(dataSource, officeId) {
  const schedule = await readSchedule(dataSource);
  const exceptions = await loadEngineEntries(dataSource, officeId);
  return createCalendar({ schedule, exceptions, officeId });
}

function asHttpError(err) {
  if (err instanceof EngineError) {
    return Errors.validation(err.message, { [err.code]: err.message });
  }
  return err;
}

export async function workingMinutes(dataSource, body) {
  const startMs = parseInstant(body.start, 'start', 'Start');
  const endMs = parseInstant(body.end, 'end', 'End');
  const officeId = parseEngineOfficeId(body.officeId);
  if (endMs <= startMs) throw Errors.validation(MSG.END_AFTER_START, { end: MSG.END_AFTER_START });
  const calendar = await loadCalendar(dataSource, officeId);
  try {
    return { working_minutes: computeWorkingMinutes(calendar, startMs, endMs) };
  } catch (err) {
    throw asHttpError(err);
  }
}

export async function deadline(dataSource, body) {
  const startMs = parseInstant(body.start, 'start', 'Start');
  const officeId = parseEngineOfficeId(body.officeId);
  const workingDays = body.workingDays;
  const heldMinutes = body.heldMinutes === undefined || body.heldMinutes === null ? 0 : body.heldMinutes;
  const calendar = await loadCalendar(dataSource, officeId);
  try {
    return { deadline: formatManilaIso(computeDeadline(calendar, { startMs, workingDays, heldMinutes })) };
  } catch (err) {
    throw asHttpError(err);
  }
}

export async function isWorkingDay(dataSource, { date, officeId }) {
  if (typeof date !== 'string' || !isValidManilaDate(date)) {
    throw Errors.validation('date must be a date (YYYY-MM-DD)', { date: 'date must be a date (YYYY-MM-DD)' });
  }
  const office = parseEngineOfficeId(officeId);
  return describeDay(await loadCalendar(dataSource, office), date);
}
