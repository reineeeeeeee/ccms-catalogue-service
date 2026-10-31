// EB4: a part-day suspension with an end time leaves the rest of the day working (pure, no database).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { D, entry, minutes } from './fixtures.js';

describe('suspended_from + suspended_until', () => {
  it('Thursday 08:00-19:00 suspended 13:00-17:00 leaves 7 working hours', () => {
    assert.equal(minutes(D.thu, '08:00', D.thu, '19:00', [entry(D.thu, { exception_type: 'SUSPENSION', suspended_from: '13:00', suspended_until: '17:00' })]), 7 * 60);
  });

  it('a start only keeps the old effect (suspended until closing)', () => {
    assert.equal(minutes(D.thu, '08:00', D.thu, '19:00', [entry(D.thu, { exception_type: 'SUSPENSION', suspended_from: '13:00' })]), 5 * 60);
  });
});
