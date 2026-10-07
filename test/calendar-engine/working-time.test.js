// TT1 / CC017: fixed tests for the working-time and deadline engine. Pure: no database, no network.
// Every expected value is written out by hand from the sprint text, never computed by the code under test.
// The whole file is run again under TZ=UTC and a daylight-saving zone by scripts/test-engine-tz.mjs.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { manilaParts } from 'ccms-shared';
import {
  EngineError,
  computeDeadline,
  computeWorkingMinutes,
  dateOfDayIndex,
  dayIndexOfDate,
  dayIndexOfInstant,
  describeDay,
  formatManilaIso,
  instantAt,
  weekdayOfDayIndex,
} from '../../src/lib/calendar/engine/working-time.js';
import { CHARTER_SCHEDULE, D, DEFAULT_SCHEDULE, OFFICE_A, OFFICE_B, at, calendar, deadline, entry, minutes } from './fixtures.js';

const iso = (ms) => formatManilaIso(ms);

describe('server clock independence (AC14)', () => {
  it('runs in the requested server time zone', () => {
    const expected = process.env.CCMS_EXPECT_TZ_OFFSET;
    if (expected === undefined) return; // default run: any zone
    assert.equal(String(new Date(2026, 0, 1).getTimezoneOffset()), expected);
  });

  it('fixtures really fall on the weekdays the tests name', () => {
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    assert.equal(names[weekdayOfDayIndex(dayIndexOfDate(D.tue))], 'tue');
    assert.equal(names[weekdayOfDayIndex(dayIndexOfDate(D.sat))], 'sat');
    assert.equal(names[weekdayOfDayIndex(dayIndexOfDate(D.mon))], 'mon');
    assert.equal(names[weekdayOfDayIndex(dayIndexOfDate('2026-12-30'))], 'wed');
    assert.equal(names[weekdayOfDayIndex(dayIndexOfDate('1969-12-31'))], 'wed');
  });
});

describe('date helpers', () => {
  it('round-trips dates and agrees with the shared Manila helpers', () => {
    for (const date of ['2026-01-01', '2026-10-06', '2027-01-01', '2028-02-29', '1999-12-31']) {
      assert.equal(dateOfDayIndex(dayIndexOfDate(date)), date);
    }
    // 2026-10-06 23:30 Manila = 15:30 UTC; 2026-10-07 00:00 Manila = 16:00 UTC the day before.
    assert.equal(dateOfDayIndex(dayIndexOfInstant(Date.parse('2026-10-06T15:59:59Z'))), '2026-10-06');
    assert.equal(dateOfDayIndex(dayIndexOfInstant(Date.parse('2026-10-06T16:00:00Z'))), '2026-10-07');
    const parts = manilaParts(at('2026-10-06', '10:30'));
    assert.deepEqual([parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.weekday], [2026, 10, 6, 10, 30, 2]);
  });

  it('formats an instant with the +08:00 offset', () => {
    assert.equal(iso(at(D.fri, '19:00')), '2026-10-09T19:00:00+08:00');
    assert.equal(iso(Date.parse('2026-10-09T11:00:00Z')), '2026-10-09T19:00:00+08:00');
    assert.equal(iso(instantAt(dayIndexOfDate('2027-01-01'), 0)), '2027-01-01T00:00:00+08:00');
  });
});

describe('CC017 working minutes: AC1-AC6, AC13', () => {
  it('AC1: Tue 10:00 to Tue 11:30 = 90', () => {
    assert.equal(minutes(D.tue, '10:00', D.tue, '11:30'), 90);
  });

  it('AC2: Tue 18:30 to Wed 08:30 = 60', () => {
    assert.equal(minutes(D.tue, '18:30', D.wed, '08:30'), 60);
  });

  it('AC3: Fri 18:00 to Tue 09:00 = 660 (Fri 60 + Sat 540 + Tue 60)', () => {
    assert.equal(minutes(D.fri, '18:00', D.tue2, '09:00'), 660);
  });

  it('AC4: with a campus-wide holiday on Wed, Tue 18:00 to Thu 09:00 = 120', () => {
    assert.equal(minutes(D.tue, '18:00', D.thu, '09:00', [entry(D.wed)]), 120);
    // Without the holiday the same span is Tue 60 + Wed 660 + Thu 60.
    assert.equal(minutes(D.tue, '18:00', D.thu, '09:00'), 780);
  });

  it('AC5: an office-specific suspension on Wed for office A only: office A 120, office B 780', () => {
    const suspension = entry(D.wed, { exception_type: 'SUSPENSION', office_id: OFFICE_A });
    assert.equal(minutes(D.tue, '18:00', D.thu, '09:00', [suspension], OFFICE_A), 120);
    assert.equal(minutes(D.tue, '18:00', D.thu, '09:00', [suspension], OFFICE_B), 780);
    // Campus-only callers (no office) are not affected by an office's entry either.
    assert.equal(minutes(D.tue, '18:00', D.thu, '09:00', [suspension], null), 780);
  });

  it('AC6: a suspension from 13:00 on Wed, Wed 12:00 to Wed 15:00 = 60', () => {
    const suspension = entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '13:00' });
    assert.equal(minutes(D.wed, '12:00', D.wed, '15:00', [suspension]), 60);
  });

  it('AC13: an end not after the start is refused with "End must be after start"', () => {
    const cal = calendar();
    for (const [start, end] of [
      [at(D.tue, '10:00'), at(D.tue, '10:00')],
      [at(D.tue, '10:00'), at(D.tue, '09:00')],
    ]) {
      assert.throws(() => computeWorkingMinutes(cal, start, end), (err) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.code, 'END_NOT_AFTER_START');
        assert.equal(err.message, 'End must be after start');
        return true;
      });
    }
  });
});

describe('CC017 deadlines: AC7-AC12', () => {
  it('AC7: start Tue 15:00, 3 working days: Fri 19:00', () => {
    assert.equal(iso(deadline(D.tue, '15:00', 3)), '2026-10-09T19:00:00+08:00');
  });

  it('AC8: start Fri 10:00, 1 working day: Sat 17:00', () => {
    assert.equal(iso(deadline(D.fri, '10:00', 1)), '2026-10-10T17:00:00+08:00');
  });

  it('AC9: start Fri 10:00, 2 working days: Tue 19:00', () => {
    assert.equal(iso(deadline(D.fri, '10:00', 2)), '2026-10-13T19:00:00+08:00');
  });

  it('AC10: start Tue 15:00, 3 working days, holiday on Thu: Sat 17:00', () => {
    assert.equal(iso(deadline(D.tue, '15:00', 3, { exceptions: [entry(D.thu)] })), '2026-10-10T17:00:00+08:00');
  });

  it('AC11: start Tue 15:00, 3 working days, 120 held minutes: Sat 10:00', () => {
    assert.equal(iso(deadline(D.tue, '15:00', 3, { heldMinutes: 120 })), '2026-10-10T10:00:00+08:00');
  });

  it('AC12: start Sun 10:00, 1 working day: Tue 19:00', () => {
    assert.equal(iso(deadline(D.sun, '10:00', 1)), '2026-10-13T19:00:00+08:00');
  });

  it('the start day is not counted and the last day is (start exactly at opening, at closing, at midnight)', () => {
    assert.equal(iso(deadline(D.tue, '08:00', 1)), '2026-10-07T19:00:00+08:00');
    assert.equal(iso(deadline(D.tue, '19:00', 1)), '2026-10-07T19:00:00+08:00');
    assert.equal(iso(deadline(D.tue, '00:00', 1)), '2026-10-07T19:00:00+08:00');
    assert.equal(iso(deadline(D.tue, '23:59', 1)), '2026-10-07T19:00:00+08:00');
  });

  it('default Mon-Fri 08:00-17:00 schedule: weekends are skipped', () => {
    const cal = calendar([], null, DEFAULT_SCHEDULE);
    const start = at('2026-10-05', '09:00'); // Monday
    assert.equal(iso(computeDeadline(cal, { startMs: start, workingDays: 4 })), '2026-10-09T17:00:00+08:00'); // Fri
    assert.equal(iso(computeDeadline(cal, { startMs: start, workingDays: 5 })), '2026-10-12T17:00:00+08:00'); // next Mon
    assert.equal(iso(computeDeadline(cal, { startMs: start, workingDays: 6 })), '2026-10-13T17:00:00+08:00');
  });

  it('a whole-day office entry skips that day for that office only', () => {
    const closure = entry(D.wed, { exception_type: 'SUSPENSION', office_id: OFFICE_A });
    assert.equal(iso(deadline(D.tue, '15:00', 1, { exceptions: [closure], officeId: OFFICE_A })), '2026-10-08T19:00:00+08:00');
    assert.equal(iso(deadline(D.tue, '15:00', 1, { exceptions: [closure], officeId: OFFICE_B })), '2026-10-07T19:00:00+08:00');
  });

  it('a partial-suspension day still counts as a working day and closes at the suspension time (team default)', () => {
    const suspension = entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '13:00' });
    assert.equal(iso(deadline(D.tue, '15:00', 1, { exceptions: [suspension] })), '2026-10-07T13:00:00+08:00');
  });

  it('hold extension: ends exactly at a closing time, spans several days, and starts from the deadline', () => {
    // AC7 deadline is Fri 19:00; Sat holds 8:00-17:00 = 540 minutes.
    assert.equal(iso(deadline(D.tue, '15:00', 3, { heldMinutes: 540 })), '2026-10-10T17:00:00+08:00');
    assert.equal(iso(deadline(D.tue, '15:00', 3, { heldMinutes: 541 })), '2026-10-13T08:01:00+08:00');
    // 540 (Sat) + 660 (Tue) + 1 more = Wed 08:01
    assert.equal(iso(deadline(D.tue, '15:00', 3, { heldMinutes: 1201 })), '2026-10-14T08:01:00+08:00');
    assert.equal(iso(deadline(D.tue, '15:00', 3, { heldMinutes: 0 })), '2026-10-09T19:00:00+08:00');
  });

  it('hold extension skips a holiday and a cut day', () => {
    const exceptions = [entry(D.sat), entry(D.tue2, { exception_type: 'SUSPENSION', suspended_from: '09:00' })];
    // Fri 19:00 + 120: Sat holiday, Sun/Mon off, Tue 08:00-09:00 (60), Wed 08:00 + 60 = 09:00.
    assert.equal(iso(deadline(D.tue, '15:00', 3, { heldMinutes: 120, exceptions })), '2026-10-14T09:00:00+08:00');
  });

  it('rejects unusable inputs', () => {
    const cal = calendar();
    const startMs = at(D.tue, '15:00');
    for (const workingDays of [0, -1, 1.5, '3', null, undefined, 3001]) {
      assert.throws(() => computeDeadline(cal, { startMs, workingDays }), EngineError, `workingDays ${workingDays}`);
    }
    for (const heldMinutes of [-1, 1.5, '5']) {
      assert.throws(() => computeDeadline(cal, { startMs, workingDays: 1, heldMinutes }), EngineError, `heldMinutes ${heldMinutes}`);
    }
    assert.throws(() => computeDeadline(cal, { startMs: Number.NaN, workingDays: 1 }), EngineError);
  });

  it('reports a calendar with no working days instead of looping forever', () => {
    const cal = calendar([], null, CHARTER_SCHEDULE.map((row) => ({ ...row, is_working: false })));
    assert.throws(() => computeDeadline(cal, { startMs: at(D.tue, '15:00'), workingDays: 1 }), /no working days/);
  });
});

describe('TT1 extra boundary cases', () => {
  it('start and end on the same non-working day = 0', () => {
    assert.equal(minutes(D.sun, '09:00', D.sun, '15:00'), 0);
    assert.equal(minutes(D.mon, '00:00', D.mon, '23:59'), 0);
    // A whole-day holiday on a working day behaves the same way.
    assert.equal(minutes(D.wed, '09:00', D.wed, '15:00', [entry(D.wed)]), 0);
  });

  it('start before opening and end after closing on one day = the full window', () => {
    assert.equal(minutes(D.tue, '05:00', D.tue, '23:00'), 660); // 08:00-19:00
    assert.equal(minutes(D.sat, '00:00', D.sat, '23:59'), 540); // 08:00-17:00
    assert.equal(minutes(D.wed, '05:00', D.wed, '23:00', [entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '13:00' })]), 300);
  });

  it('a span crossing a year end', () => {
    // Wed 2026-12-30 18:00 to Tue 2027-01-05 09:00: Wed 60, Thu 660, Fri 660, Sat 540, Sun/Mon 0, Tue 60.
    assert.equal(minutes('2026-12-30', '18:00', '2027-01-05', '09:00'), 1980);
    // The same span with New Year's Day (Fri 2027-01-01) a holiday loses that day's 660.
    assert.equal(minutes('2026-12-30', '18:00', '2027-01-05', '09:00', [entry('2027-01-01')]), 1320);
    // Recurring Jan 1 anchored in 2026 also takes out Jan 1 of 2027.
    assert.equal(minutes('2026-12-30', '18:00', '2027-01-05', '09:00', [entry('2026-01-01', { is_recurring: true })]), 1320);
  });

  it('a deadline that crosses a year end', () => {
    // Start Wed 2026-12-30: Thu 31 (1), Fri Jan 1 (2), Sat Jan 2 (3) closes 17:00.
    assert.equal(iso(deadline('2026-12-30', '10:00', 3)), '2027-01-02T17:00:00+08:00');
    // With Jan 1 a recurring holiday the third working day moves to Tue Jan 5.
    const holiday = [entry('2026-01-01', { is_recurring: true })];
    assert.equal(iso(deadline('2026-12-30', '10:00', 3, { exceptions: holiday })), '2027-01-05T19:00:00+08:00');
  });

  it('whole minutes, rounded down; seconds inside the window are not rounded up', () => {
    const cal = calendar();
    const start = Date.parse('2026-10-06T10:00:30+08:00');
    assert.equal(computeWorkingMinutes(cal, start, Date.parse('2026-10-06T10:01:29+08:00')), 0);
    assert.equal(computeWorkingMinutes(cal, start, Date.parse('2026-10-06T10:02:00+08:00')), 1);
    assert.equal(computeWorkingMinutes(cal, start, Date.parse('2026-10-06T11:30:00+08:00')), 89);
  });

  it('timestamps in any offset mean the same instant', () => {
    const cal = calendar();
    // 10:00-11:30 Manila written as 02:00Z-03:30Z, and with a -05:00 offset.
    assert.equal(computeWorkingMinutes(cal, Date.parse('2026-10-06T02:00:00Z'), Date.parse('2026-10-06T03:30:00Z')), 90);
    assert.equal(computeWorkingMinutes(cal, Date.parse('2026-10-05T21:00:00-05:00'), Date.parse('2026-10-05T22:30:00-05:00')), 90);
    // 23:00Z on Tue is 07:00 Wed in Manila: Tue's UTC date is not the Manila date.
    assert.equal(computeWorkingMinutes(cal, Date.parse('2026-10-06T23:00:00Z'), Date.parse('2026-10-07T03:00:00Z')), 180);
  });

  it('a window ends exactly at midnight without counting the next day twice', () => {
    const cal = calendar([], null, CHARTER_SCHEDULE.map((row) => (row.is_working ? { ...row, opening_time: '08:00', closing_time: '23:59' } : row)));
    assert.equal(computeWorkingMinutes(cal, at(D.tue, '23:00'), at(D.wed, '00:00')), 59);
    assert.equal(computeWorkingMinutes(cal, at(D.tue, '23:59'), at(D.wed, '00:00')), 0);
  });

  it('per-day hours: each weekday uses its own opening and closing time', () => {
    // Tue 08:00-19:00 and Sat 08:00-17:00: the whole Tue..Sat week.
    assert.equal(minutes(D.tue, '00:00', D.sat, '23:59'), 660 * 4 + 540);
  });

  it('refuses spans beyond the ten-year limit', () => {
    assert.throws(() => minutes('2020-01-01', '00:00', '2031-01-01', '00:00'), (err) => err.code === 'SPAN_TOO_LONG');
  });
});

describe('exceptions in the engine', () => {
  it('whole-day entries win over a suspended_from on the same date, campus or office', () => {
    const cal = calendar(
      [
        entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '13:00', office_id: OFFICE_A }),
        entry(D.wed), // campus-wide whole day
      ],
      OFFICE_A,
    );
    assert.equal(describeDay(cal, D.wed).is_working_day, false);
  });

  it('otherwise the earliest suspended_from applies', () => {
    const cal = calendar(
      [
        entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '15:00' }),
        entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '11:00', office_id: OFFICE_A }),
      ],
      OFFICE_A,
    );
    assert.deepEqual(describeDay(cal, D.wed).window, { opening_time: '08:00', closing_time: '11:00' });
    // Office B only sees the campus-wide suspension.
    const forB = calendar(
      [
        entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '15:00' }),
        entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '11:00', office_id: OFFICE_A }),
      ],
      OFFICE_B,
    );
    assert.deepEqual(describeDay(forB, D.wed).window, { opening_time: '08:00', closing_time: '15:00' });
  });

  it('a suspension at or before opening leaves no window, so the day is not counted', () => {
    const cal = calendar([entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '08:00' })]);
    assert.equal(describeDay(cal, D.wed).is_working_day, false);
  });

  it('a suspended_from after closing changes nothing', () => {
    const cal = calendar([entry(D.wed, { exception_type: 'SUSPENSION', suspended_from: '21:00' })]);
    assert.deepEqual(describeDay(cal, D.wed).window, { opening_time: '08:00', closing_time: '19:00' });
  });

  it('CC015 AC5: a recurring Jan 1 anchored in 2026 is non-working in 2026 and later, not before', () => {
    const cal = calendar([entry('2026-01-01', { is_recurring: true })], null, DEFAULT_SCHEDULE);
    assert.equal(describeDay(cal, '2025-01-01').is_working_day, true); // Wed, but before the anchor year
    assert.equal(describeDay(cal, '2026-01-01').is_working_day, false);
    assert.equal(describeDay(cal, '2027-01-01').is_working_day, false); // Fri
    assert.equal(describeDay(cal, '2029-01-01').is_working_day, false); // Mon
    assert.equal(describeDay(cal, '2030-01-01').is_working_day, false); // Tue
  });

  it('CC015 AC8: a recurring Feb 29 applies only in leap years', () => {
    const cal = calendar([entry('2024-02-29', { is_recurring: true })], null, DEFAULT_SCHEDULE);
    assert.equal(describeDay(cal, '2024-02-29').is_working_day, false); // Thu
    assert.equal(describeDay(cal, '2028-02-29').is_working_day, false); // Tue
    assert.equal(describeDay(cal, '2027-02-26').is_working_day, true); // Fri, a non-leap year
    assert.equal(describeDay(cal, '2027-03-01').is_working_day, true); // Mon: not shifted
    assert.equal(describeDay(cal, '2029-02-28').is_working_day, true); // Wed
    assert.equal(describeDay(cal, '2029-03-01').is_working_day, true);
    assert.equal(describeDay(cal, '2023-02-28').is_working_day, true); // before the anchor
  });

  it('a one-time entry applies on its own date only', () => {
    const cal = calendar([entry('2026-10-07')]);
    assert.equal(describeDay(cal, '2026-10-07').is_working_day, false);
    assert.equal(describeDay(cal, '2027-10-07').is_working_day, true);
    assert.equal(describeDay(cal, '2025-10-07').is_working_day, true);
  });

  it('past dates work the same as future dates', () => {
    assert.equal(minutes('2019-03-05', '09:00', '2019-03-05', '10:00', [entry('2019-03-05')]), 0);
    assert.equal(minutes('2019-03-05', '09:00', '2019-03-05', '10:00'), 60); // Tue
  });
});

describe('is-working-day description', () => {
  it('returns the window of a working day and null otherwise', () => {
    const cal = calendar();
    assert.deepEqual(describeDay(cal, D.tue), { is_working_day: true, window: { opening_time: '08:00', closing_time: '19:00' } });
    assert.deepEqual(describeDay(cal, D.sat), { is_working_day: true, window: { opening_time: '08:00', closing_time: '17:00' } });
    assert.deepEqual(describeDay(cal, D.sun), { is_working_day: false, window: null });
  });

  it('a schedule row with unusable times is treated as non-working instead of crashing', () => {
    const cal = calendar([], null, [{ day_of_week: 2, is_working: true, opening_time: 'bad', closing_time: '17:00' }]);
    assert.equal(describeDay(cal, D.tue).is_working_day, false);
  });
});

// An independent, deliberately slow reference: walks the span one minute at a time and asks the shared
// Intl-based Manila helpers which date and time each minute falls on.
function referenceMinutes(startMs, endMs, exceptionDates, schedule) {
  let count = 0;
  for (let t = startMs; t < endMs; t += 60_000) {
    const p = manilaParts(t);
    const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (exceptionDates.has(date)) continue;
    const row = schedule[p.weekday];
    if (!row.is_working) continue;
    const minute = p.hour * 60 + p.minute;
    const [oh, om] = row.opening_time.split(':').map(Number);
    const [ch, cm] = row.closing_time.split(':').map(Number);
    if (minute >= oh * 60 + om && minute < ch * 60 + cm) count += 1;
  }
  return count;
}

describe('cross-check against a minute-by-minute reference', () => {
  it('agrees on 80 fixed pseudo-random spans across a year end with holidays', () => {
    let seed = 20261001;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const holidays = ['2026-12-25', '2026-12-30', '2027-01-01'];
    const cal = calendar(holidays.map((date) => entry(date)));
    const dates = new Set(holidays);
    const base = at('2026-12-20', '00:00');
    for (let i = 0; i < 80; i += 1) {
      const start = base + Math.floor(random() * 20 * 1440) * 60_000;
      const end = start + (1 + Math.floor(random() * 5 * 1440)) * 60_000;
      assert.equal(
        computeWorkingMinutes(cal, start, end),
        referenceMinutes(start, end, dates, CHARTER_SCHEDULE),
        `span ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`,
      );
    }
  });
});

describe('AC15: spans up to 60 days return within 2 seconds', () => {
  it('computes a 60-day span with a thousand calendar entries well inside the limit', () => {
    const exceptions = [];
    for (let i = 0; i < 1000; i += 1) {
      const d = new Date(Date.UTC(2020, 0, 1 + i * 3));
      exceptions.push(entry(d.toISOString().slice(0, 10), { office_id: i % 2 ? OFFICE_A : null }));
    }
    const started = Date.now();
    const cal = calendar(exceptions, OFFICE_A);
    const result = computeWorkingMinutes(cal, at('2026-08-01', '00:00'), at('2026-09-30', '23:59'));
    const elapsed = Date.now() - started;
    assert.ok(result > 0);
    assert.ok(elapsed < 2000, `took ${elapsed} ms`);
    const deadlineStarted = Date.now();
    computeDeadline(cal, { startMs: at('2026-08-01', '00:00'), workingDays: 60, heldMinutes: 5000 });
    assert.ok(Date.now() - deadlineStarted < 2000);
  });
});
