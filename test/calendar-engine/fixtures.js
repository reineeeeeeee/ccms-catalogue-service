// Shared fixtures for the engine suite. Not a test file (no .test.js suffix).
import { computeDeadline, computeWorkingMinutes, createCalendar } from '../../src/lib/calendar/engine/working-time.js';

export const OFFICE_A = '11111111-1111-4111-8111-111111111111';
export const OFFICE_B = '22222222-2222-4222-8222-222222222222';

const day = (day_of_week, is_working, opening_time = null, closing_time = null) => ({
  day_of_week,
  is_working,
  opening_time: is_working ? opening_time : null,
  closing_time: is_working ? closing_time : null,
});

// CC014 AC1 schedule: Tue-Fri 08:00-19:00, Sat 08:00-17:00, Sun and Mon non-working.
export const CHARTER_SCHEDULE = [
  day(0, false),
  day(1, false),
  day(2, true, '08:00', '19:00'),
  day(3, true, '08:00', '19:00'),
  day(4, true, '08:00', '19:00'),
  day(5, true, '08:00', '19:00'),
  day(6, true, '08:00', '17:00'),
];

// Default seed: Mon-Fri 08:00-17:00.
export const DEFAULT_SCHEDULE = [
  day(0, false),
  day(1, true, '08:00', '17:00'),
  day(2, true, '08:00', '17:00'),
  day(3, true, '08:00', '17:00'),
  day(4, true, '08:00', '17:00'),
  day(5, true, '08:00', '17:00'),
  day(6, false),
];

// October 2026: Tue 6, Wed 7, Thu 8, Fri 9, Sat 10, Sun 11, Mon 12, Tue 13.
export const D = Object.freeze({
  tue: '2026-10-06',
  wed: '2026-10-07',
  thu: '2026-10-08',
  fri: '2026-10-09',
  sat: '2026-10-10',
  sun: '2026-10-11',
  mon: '2026-10-12',
  tue2: '2026-10-13',
});

/** Epoch ms of a Manila wall-clock time, written with an explicit offset so the server clock never matters. */
export const at = (date, time = '00:00') => Date.parse(`${date}T${time}:00+08:00`);

export const entry = (exception_date, extra = {}) => ({
  exception_date,
  exception_type: 'REGULAR_HOLIDAY',
  description: 'test',
  office_id: null,
  suspended_from: null,
  is_recurring: false,
  ...extra,
});

export const calendar = (exceptions = [], officeId = null, schedule = CHARTER_SCHEDULE) =>
  createCalendar({ schedule, exceptions, officeId });

export const minutes = (startDate, startTime, endDate, endTime, exceptions = [], officeId = null, schedule = CHARTER_SCHEDULE) =>
  computeWorkingMinutes(calendar(exceptions, officeId, schedule), at(startDate, startTime), at(endDate, endTime));

export const deadline = (startDate, startTime, workingDays, { heldMinutes = 0, exceptions = [], officeId = null, schedule = CHARTER_SCHEDULE } = {}) =>
  computeDeadline(calendar(exceptions, officeId, schedule), { startMs: at(startDate, startTime), workingDays, heldMinutes });
