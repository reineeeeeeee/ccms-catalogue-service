import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  endOfManilaDay,
  fromManila,
  isValidManilaDate,
  manilaWeekday,
  startOfManilaDay,
  toManilaDate,
  toManilaDateTime,
  toUtcIso,
} from '../src/time.js';

describe('time utilities (Asia/Manila)', () => {
  it('derives the Manila calendar date even when the server clock is UTC', () => {
    // 17:00 UTC on 31 Mar is already 01:00 on 1 Apr in Manila.
    assert.equal(toManilaDate('2026-03-31T17:00:00Z'), '2026-04-01');
    assert.equal(toManilaDate('2026-03-31T15:59:59Z'), '2026-03-31');
    assert.equal(toManilaDateTime('2026-03-31T17:00:00Z'), '2026-04-01 01:00:00');
  });

  it('matches the Manila calendar regardless of the process time zone', () => {
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        assert.equal(toManilaDate('2026-12-31T16:30:00Z'), '2027-01-01');
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('converts a Manila wall-clock time to the UTC instant', () => {
    assert.equal(fromManila('2026-04-01', '08:30').toISOString(), '2026-04-01T00:30:00.000Z');
    assert.equal(fromManila('2026-04-01').toISOString(), '2026-03-31T16:00:00.000Z');
  });

  it('finds the start and end of a Manila day', () => {
    const instant = '2026-03-31T20:00:00Z'; // 04:00 on 1 Apr in Manila
    assert.equal(startOfManilaDay(instant).toISOString(), '2026-03-31T16:00:00.000Z');
    assert.equal(endOfManilaDay(instant).toISOString(), '2026-04-01T15:59:59.999Z');
  });

  it('reports the weekday by the Manila calendar', () => {
    assert.equal(manilaWeekday('2026-09-30T20:00:00Z'), 4); // Thursday 1 Oct in Manila
    assert.equal(manilaWeekday('2026-09-30T10:00:00Z'), 3); // Wednesday 30 Sep in Manila
  });

  it('validates dates and rejects impossible ones', () => {
    assert.equal(isValidManilaDate('2026-02-28'), true);
    assert.equal(isValidManilaDate('2026-02-30'), false);
    assert.equal(isValidManilaDate('26-02-28'), false);
    assert.throws(() => fromManila('2026-02-30'), RangeError);
    assert.throws(() => toManilaDate('not a date'), RangeError);
  });

  it('serialises timestamps as UTC ISO strings', () => {
    assert.equal(toUtcIso(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
  });
});
