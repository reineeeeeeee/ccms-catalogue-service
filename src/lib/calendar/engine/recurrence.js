// Pure calendar-date rules for exception entries (no I/O, no clock, no server-local time).
// Dates are Manila calendar dates written 'YYYY-MM-DD'. Recurring entries are fixed-date holidays:
// they apply on the same month and day of their anchor year and every later year, never before it.
// A recurring Feb 29 entry therefore applies only in leap years (Feb 29 does not exist in other years).

export function yearOf(dateString) {
  return Number(dateString.slice(0, 4));
}

/** 'MM-DD' of a 'YYYY-MM-DD' date. */
export function monthDayOf(dateString) {
  return dateString.slice(5, 10);
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const scopeOf = (entry) => entry.office_id ?? null;

/** True when the entry is in force on the given Manila date. */
export function occursOn(entry, dateString) {
  if (!entry.is_recurring) return entry.exception_date === dateString;
  return monthDayOf(entry.exception_date) === monthDayOf(dateString) && yearOf(dateString) >= yearOf(entry.exception_date);
}

/**
 * Whether two entries would both apply on some date for the same scope (same office, or both
 * campus-wide). This is the application-level uniqueness rule that backs the database index:
 *   - one-time vs one-time: the same date;
 *   - recurring vs anything: the same month and day, where the one-time date must not be earlier
 *     than the recurring entry's anchor year (before that year the recurring entry does not apply);
 *   - recurring vs recurring: the same month and day (both repeat forever).
 */
export function entriesConflict(a, b) {
  if (scopeOf(a) !== scopeOf(b)) return false;
  if (!a.is_recurring && !b.is_recurring) return a.exception_date === b.exception_date;
  if (monthDayOf(a.exception_date) !== monthDayOf(b.exception_date)) return false;
  if (a.is_recurring && b.is_recurring) return true;
  const recurring = a.is_recurring ? a : b;
  const oneTime = a.is_recurring ? b : a;
  return yearOf(oneTime.exception_date) >= yearOf(recurring.exception_date);
}

/**
 * The dates on which an entry applies inside [from, to] (inclusive, 'YYYY-MM-DD'), ascending.
 * One-time entries give at most their own date; recurring ones are expanded per year.
 */
export function occurrencesInRange(entry, from, to) {
  if (!entry.is_recurring) {
    const date = entry.exception_date;
    return (!from || date >= from) && (!to || date <= to) ? [date] : [];
  }
  const monthDay = monthDayOf(entry.exception_date);
  const anchorYear = yearOf(entry.exception_date);
  const firstYear = Math.max(anchorYear, from ? yearOf(from) : anchorYear);
  const lastYear = to ? yearOf(to) : firstYear;
  const dates = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    if (monthDay === '02-29' && !isLeapYear(year)) continue;
    const date = `${String(year).padStart(4, '0')}-${monthDay}`;
    if ((!from || date >= from) && (!to || date <= to)) dates.push(date);
  }
  return dates;
}
