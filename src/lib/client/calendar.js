// Helpers for the Calendar page. All dates and times are Asia/Manila (fixed UTC+08:00, no daylight
// saving), handled as plain strings or with UTC arithmetic so the browser's own time zone never matters.

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first; the API uses 0 = Sunday

/** "Mon-Fri 08:00-17:00 · Sat 08:00-12:00" for a list of schedule items (non-working days are left out). */
export function describeSchedule(items) {
  const byDay = new Map(items.map((item) => [item.day_of_week, item]));
  const groups = [];
  for (const day of WEEK_ORDER) {
    const item = byDay.get(day);
    if (!item?.is_working) continue;
    const window = `${item.opening_time}-${item.closing_time}`;
    const last = groups.at(-1);
    if (last && last.window === window && last.end === WEEK_ORDER[WEEK_ORDER.indexOf(day) - 1]) last.end = day;
    else groups.push({ start: day, end: day, window });
  }
  if (groups.length === 0) return 'No working days';
  return groups.map((g) => `${g.start === g.end ? DAY_SHORT[g.start] : `${DAY_SHORT[g.start]}-${DAY_SHORT[g.end]}`} ${g.window}`).join(' · ');
}
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const EXCEPTION_TYPES = [
  { value: 'REGULAR_HOLIDAY', label: 'Regular holiday' },
  { value: 'SPECIAL_NON_WORKING', label: 'Special non-working day' },
  { value: 'LOCAL_HOLIDAY', label: 'Local holiday' },
  { value: 'SUSPENSION', label: 'Suspension of work' },
];

export function typeLabel(value) {
  return EXCEPTION_TYPES.find((t) => t.value === value)?.label ?? value;
}

// How the Holidays tab groups the four real types: National (red), Local (amber), Campus (blue).
// Full class names are spelled out so Tailwind picks them up.
export const TYPE_CATEGORIES = [
  { id: 'national', label: 'National', dot: 'bg-red-600', badge: 'bg-red-50 text-red-700' },
  { id: 'local', label: 'Local', dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-700' },
  { id: 'campus', label: 'Campus', dot: 'bg-blue-600', badge: 'bg-blue-50 text-blue-700' },
];
const CATEGORY_BY_TYPE = { REGULAR_HOLIDAY: 'national', SPECIAL_NON_WORKING: 'national', LOCAL_HOLIDAY: 'local', SUSPENSION: 'campus' };

export function typeCategory(value) {
  const id = CATEGORY_BY_TYPE[value] ?? 'local';
  return TYPE_CATEGORIES.find((c) => c.id === id);
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** 'YYYY-MM-DD HH:MM' in Manila for an ISO timestamp, or '' when it cannot be read. */
export function manilaDateTime(iso) {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  return new Date(ms + MANILA_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Today's 'YYYY-MM-DD' in Manila. */
export function todayManila() {
  return new Date(Date.now() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export function dateString(year, month, day) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Month is 1-12. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 (Sunday) to 6 for the first day of the month. */
export function firstWeekday(year, month) {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

export function shiftMonth({ year, month }, delta) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The entry's date in the given year, or null when it does not occur in that year. */
export function occurrenceIn(entry, dateStr) {
  if (entry.exception_date === dateStr) return true;
  if (!entry.is_recurring) return false;
  return entry.exception_date.slice(5) === dateStr.slice(5) && Number(dateStr.slice(0, 4)) >= Number(entry.exception_date.slice(0, 4));
}

/** The date a (possibly recurring) entry falls on inside a month, or null. */
export function occurrenceInMonth(entry, year, month) {
  if (!entry.is_recurring) {
    return entry.exception_date.slice(0, 7) === `${pad(year, 4)}-${pad(month)}` ? entry.exception_date : null;
  }
  if (Number(entry.exception_date.slice(5, 7)) !== month || year < Number(entry.exception_date.slice(0, 4))) return null;
  const date = `${pad(year, 4)}-${entry.exception_date.slice(5)}`;
  return occurrenceIn(entry, date) ? date : null;
}

export function isValidTime(text) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
}

/** Accepts HH:MM from a time input (or HH:MM:SS) and returns HH:MM. */
export function normalizeTime(text) {
  return typeof text === 'string' ? text.slice(0, 5) : '';
}

export const SYNC_LABELS = { PENDING: 'Pending', SENT: 'Sent', ACKNOWLEDGED: 'Acknowledged', FAILED: 'Failed' };
