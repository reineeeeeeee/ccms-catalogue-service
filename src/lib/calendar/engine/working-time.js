// The working-time and deadline engine (CC017). A pure module: no database, no network, no clock,
// no server-local date methods. The caller injects the weekly schedule and the calendar exceptions,
// so the same inputs always give the same answer on any server time zone.
//
// Asia/Manila is fixed at UTC+08:00 (the Philippines has no daylight saving time), so every
// conversion here is integer arithmetic on milliseconds with a constant offset.
//
// Rules (Administrative Code of 1987, Book I, Sec. 31: the start day is not counted, the last is):
//   window of a date   none when the schedule marks the weekday non-working or a whole-day entry
//                      applies (campus-wide, or that office's); otherwise opening to closing, cut at
//                      the earliest applicable suspended_from.
//   working minutes    sum over each Manila date of the overlap of [start, end] with that date's
//                      window; whole minutes, rounded down.
//   deadline           counting starts the day after the start date; the Nth date with a non-empty
//                      window is the deadline day; the deadline is that window's closing time.
//   hold extension     from that deadline, move forward through later working windows by the held
//                      working minutes.
import { MANILA_OFFSET_HOURS } from 'ccms-shared';
import { monthDayOf, occursOn } from './recurrence.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const OFFSET_MS = MANILA_OFFSET_HOURS * 3_600_000;

/** Longest span that working-minutes accepts, and how far the deadline search looks ahead. */
export const MAX_SPAN_DAYS = 3660;
export const MAX_WORKING_DAYS = 3000;

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Day number (days since 1970-01-01) of a 'YYYY-MM-DD' Manila date. */
export function dayIndexOfDate(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 'YYYY-MM-DD' of a day number. */
export function dateOfDayIndex(dayIndex) {
  const date = new Date(dayIndex * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Day number of the Manila calendar day that contains the instant (epoch milliseconds). */
export function dayIndexOfInstant(ms) {
  return Math.floor((ms + OFFSET_MS) / DAY_MS);
}

/** 0 (Sunday) to 6 (Saturday). 1970-01-01 was a Thursday. */
export function weekdayOfDayIndex(dayIndex) {
  return (((dayIndex + 4) % 7) + 7) % 7;
}

/** Epoch milliseconds of a Manila day number at a minute of the day. */
export function instantAt(dayIndex, minuteOfDay) {
  return dayIndex * DAY_MS + minuteOfDay * MINUTE_MS - OFFSET_MS;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function timeToMinutes(time) {
  const match = typeof time === 'string' ? TIME_RE.exec(time) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function minutesToTime(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** ISO-8601 timestamp with the +08:00 offset for an instant. */
export function formatManilaIso(ms) {
  const date = new Date(ms + OFFSET_MS);
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+08:00`
  );
}

/**
 * Builds a calendar for one office from injected data.
 *   schedule    [{ day_of_week, is_working, opening_time, closing_time }]  (0 = Sunday)
 *   exceptions  [{ exception_date, suspended_from, is_recurring, office_id }]  (any office; filtered here)
 *   officeId    optional. Without it only campus-wide entries apply.
 * Returns { windowOf(dayIndex) } where the window is { open, close } in minutes of the day or null.
 */
export function createCalendar({ schedule, exceptions = [], officeId = null }) {
  const byWeekday = new Array(7).fill(null);
  for (const row of schedule ?? []) {
    if (!row?.is_working) continue;
    const open = timeToMinutes(row.opening_time);
    const close = timeToMinutes(row.closing_time);
    if (open !== null && close !== null && close > open) byWeekday[row.day_of_week] = { open, close };
  }

  const office = officeId == null ? null : String(officeId).toLowerCase();
  const applicable = exceptions.filter(
    (entry) => entry.office_id == null || (office !== null && String(entry.office_id).toLowerCase() === office),
  );
  const exact = new Map(); // 'YYYY-MM-DD' -> entries
  const recurring = new Map(); // 'MM-DD' -> entries
  const add = (map, key, entry) => map.set(key, [...(map.get(key) ?? []), entry]);
  for (const entry of applicable) {
    if (entry.is_recurring) add(recurring, monthDayOf(entry.exception_date), entry);
    else add(exact, entry.exception_date, entry);
  }

  const cache = new Map();
  function compute(dayIndex) {
    const base = byWeekday[weekdayOfDayIndex(dayIndex)];
    if (!base) return null;
    const date = dateOfDayIndex(dayIndex);
    const entries = [...(exact.get(date) ?? []), ...(recurring.get(date.slice(5)) ?? [])].filter((entry) =>
      occursOn(entry, date),
    );
    let close = base.close;
    for (const entry of entries) {
      const from = entry.suspended_from == null || entry.suspended_from === '' ? null : timeToMinutes(entry.suspended_from);
      if (from === null) return null; // a whole-day entry wins over everything else
      close = Math.min(close, from); // otherwise the earliest suspended_from
    }
    return close > base.open ? { open: base.open, close } : null;
  }

  return {
    windowOf(dayIndex) {
      if (!cache.has(dayIndex)) cache.set(dayIndex, compute(dayIndex));
      return cache.get(dayIndex);
    },
  };
}

function assertInstant(value, name) {
  if (!Number.isFinite(value)) throw new EngineError('INVALID_INSTANT', `${name} must be a valid timestamp`);
}

/** Working minutes between two instants (epoch milliseconds). Whole minutes, rounded down. */
export function computeWorkingMinutes(calendar, startMs, endMs) {
  assertInstant(startMs, 'Start');
  assertInstant(endMs, 'End');
  if (!(endMs > startMs)) throw new EngineError('END_NOT_AFTER_START', 'End must be after start');
  const firstDay = dayIndexOfInstant(startMs);
  const lastDay = dayIndexOfInstant(endMs);
  if (lastDay - firstDay > MAX_SPAN_DAYS) {
    throw new EngineError('SPAN_TOO_LONG', `The span must not be longer than ${MAX_SPAN_DAYS} days`);
  }
  let total = 0;
  for (let day = firstDay; day <= lastDay; day += 1) {
    const window = calendar.windowOf(day);
    if (!window) continue;
    const overlap = Math.min(endMs, instantAt(day, window.close)) - Math.max(startMs, instantAt(day, window.open));
    if (overlap > 0) total += overlap;
  }
  return Math.floor(total / MINUTE_MS);
}

/** Moves `minutes` of working time forward from an instant. Ending exactly at a closing time stays there. */
function advanceWorkingMinutes(calendar, fromMs, minutes) {
  if (minutes === 0) return fromMs;
  let remaining = minutes;
  const firstDay = dayIndexOfInstant(fromMs);
  for (let day = firstDay; day <= firstDay + MAX_SPAN_DAYS; day += 1) {
    const window = calendar.windowOf(day);
    if (!window) continue;
    const cursor = Math.max(fromMs, instantAt(day, window.open));
    const available = Math.floor((instantAt(day, window.close) - cursor) / MINUTE_MS);
    if (available <= 0) continue;
    if (remaining <= available) return cursor + remaining * MINUTE_MS;
    remaining -= available;
  }
  throw new EngineError('NO_WORKING_TIME', 'No working time is available to extend the deadline');
}

/**
 * The working-day deadline as an instant (epoch milliseconds).
 *   startMs        when the clock starts
 *   workingDays    N >= 1
 *   heldMinutes    working minutes the transaction was on hold (default 0)
 */
export function computeDeadline(calendar, { startMs, workingDays, heldMinutes = 0 }) {
  assertInstant(startMs, 'Start');
  if (!Number.isInteger(workingDays) || workingDays < 1 || workingDays > MAX_WORKING_DAYS) {
    throw new EngineError('INVALID_WORKING_DAYS', `Working days must be a whole number from 1 to ${MAX_WORKING_DAYS}`);
  }
  if (!Number.isInteger(heldMinutes) || heldMinutes < 0) {
    throw new EngineError('INVALID_HELD_MINUTES', 'Held minutes must be a whole number of 0 or more');
  }
  let counted = 0;
  const startDay = dayIndexOfInstant(startMs);
  for (let day = startDay + 1; day <= startDay + MAX_SPAN_DAYS; day += 1) {
    const window = calendar.windowOf(day);
    if (!window) continue;
    counted += 1;
    if (counted === workingDays) {
      return advanceWorkingMinutes(calendar, instantAt(day, window.close), heldMinutes);
    }
  }
  throw new EngineError('NO_WORKING_TIME', 'The calendar has no working days in the next ten years');
}

/** { is_working_day, window: { opening_time, closing_time } | null } for a 'YYYY-MM-DD' Manila date. */
export function describeDay(calendar, dateString) {
  const window = calendar.windowOf(dayIndexOfDate(dateString));
  return {
    is_working_day: window !== null,
    window: window ? { opening_time: minutesToTime(window.open), closing_time: minutesToTime(window.close) } : null,
  };
}
