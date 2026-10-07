import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { entriesConflict, isLeapYear, occursOn, occurrencesInRange } from '../../src/lib/calendar/engine/recurrence.js';
import { OFFICE_A, OFFICE_B, entry } from './fixtures.js';

const recurring = (date, extra = {}) => entry(date, { is_recurring: true, ...extra });

describe('recurrence rules', () => {
  it('leap years', () => {
    assert.deepEqual([2024, 2028, 2000, 1900, 2100, 2026].map(isLeapYear), [true, true, true, false, false, false]);
  });

  it('occursOn: one-time on its date; recurring from its anchor year, never before', () => {
    assert.equal(occursOn(entry('2026-01-01'), '2026-01-01'), true);
    assert.equal(occursOn(entry('2026-01-01'), '2027-01-01'), false);
    assert.equal(occursOn(recurring('2026-01-01'), '2025-01-01'), false);
    assert.equal(occursOn(recurring('2026-01-01'), '2026-01-01'), true);
    assert.equal(occursOn(recurring('2026-01-01'), '2099-01-01'), true);
    assert.equal(occursOn(recurring('2026-01-01'), '2027-01-02'), false);
  });

  it('CC015 AC4/AC7: same date and scope conflicts; a one-time date covered by a recurring entry conflicts', () => {
    assert.equal(entriesConflict(entry('2026-06-12'), entry('2026-06-12')), true);
    assert.equal(entriesConflict(entry('2026-06-12'), entry('2026-06-13')), false);
    assert.equal(entriesConflict(recurring('2026-01-01'), entry('2027-01-01')), true);
    assert.equal(entriesConflict(entry('2027-01-01'), recurring('2026-01-01')), true);
    assert.equal(entriesConflict(recurring('2026-01-01'), entry('2026-01-01')), true);
    assert.equal(entriesConflict(recurring('2026-01-01'), entry('2027-01-02')), false);
  });

  it('a one-time date before the recurring entry\'s anchor year is not covered', () => {
    assert.equal(entriesConflict(recurring('2026-01-01'), entry('2025-01-01')), false);
    assert.equal(entriesConflict(entry('2025-01-01'), recurring('2026-01-01')), false);
  });

  it('two recurring entries on one month and day conflict whatever their anchor years', () => {
    assert.equal(entriesConflict(recurring('2026-01-01'), recurring('2031-01-01')), true);
    assert.equal(entriesConflict(recurring('2026-01-01'), recurring('2026-01-02')), false);
  });

  it('scopes are compared with null as a value', () => {
    assert.equal(entriesConflict(entry('2026-06-12'), entry('2026-06-12', { office_id: OFFICE_A })), false);
    assert.equal(entriesConflict(entry('2026-06-12', { office_id: OFFICE_A }), entry('2026-06-12', { office_id: OFFICE_A })), true);
    assert.equal(entriesConflict(entry('2026-06-12', { office_id: OFFICE_A }), entry('2026-06-12', { office_id: OFFICE_B })), false);
    assert.equal(entriesConflict(recurring('2026-01-01'), entry('2027-01-01', { office_id: OFFICE_A })), false);
  });

  it('recurring Feb 29 conflicts with a one-time Feb 29 in a later leap year only', () => {
    assert.equal(entriesConflict(recurring('2024-02-29'), entry('2028-02-29')), true);
    assert.equal(entriesConflict(recurring('2024-02-29'), entry('2027-02-28')), false);
  });

  it('occurrencesInRange expands recurring entries per year (Feb 29 only in leap years)', () => {
    assert.deepEqual(occurrencesInRange(recurring('2026-01-01'), '2025-06-01', '2028-12-31'), ['2026-01-01', '2027-01-01', '2028-01-01']);
    assert.deepEqual(occurrencesInRange(recurring('2024-02-29'), '2024-01-01', '2032-12-31'), ['2024-02-29', '2028-02-29', '2032-02-29']);
    assert.deepEqual(occurrencesInRange(recurring('2024-02-29'), '2025-01-01', '2027-12-31'), []);
    assert.deepEqual(occurrencesInRange(entry('2026-05-05'), '2026-05-05', '2026-05-05'), ['2026-05-05']);
    assert.deepEqual(occurrencesInRange(entry('2026-05-05'), '2026-05-06', '2026-06-01'), []);
    assert.deepEqual(occurrencesInRange(recurring('2026-12-31'), '2027-01-01', '2027-12-30'), []);
    assert.deepEqual(occurrencesInRange(recurring('2026-12-31'), '2026-12-31', '2027-12-31'), ['2026-12-31', '2027-12-31']);
  });
});
