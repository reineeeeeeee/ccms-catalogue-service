// CC017 / TT3: the engine endpoints, end to end with the database (run again under other server time
// zones by scripts/test-engine-tz.mjs). Every sprint acceptance criterion AC1-AC15 is exercised over HTTP.
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { POST as postDeadline } from '../src/app/api/deadline/route.js';
import { POST as postException } from '../src/app/api/exceptions/route.js';
import { GET as isWorkingDay } from '../src/app/api/is-working-day/route.js';
import { PUT as putSchedule } from '../src/app/api/schedule/route.js';
import { POST as postMinutes } from '../src/app/api/working-minutes/route.js';
import { CHARTER_DAYS, OFFICE_A, OFFICE_B, SERVICE_KEY, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  const saved = await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }));
  assert.equal(saved.status, 200);
});
after(async () => env?.teardown());

const key = { key: SERVICE_KEY };
const minutes = async (body, opts = key) => {
  const response = await postMinutes(req('POST', '/working-minutes', { ...opts, body }));
  return { status: response.status, body: await response.json() };
};
const deadline = async (body, opts = key) => {
  const response = await postDeadline(req('POST', '/deadline', { ...opts, body }));
  return { status: response.status, body: await response.json() };
};
const day = async (query, opts = key) => {
  const response = await isWorkingDay(req('GET', `/is-working-day${query}`, opts));
  return { status: response.status, body: await response.json() };
};
const addEntry = async (body) => {
  const response = await postException(req('POST', '/exceptions', { token: tokens.superAdmin, body }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json()).exception.exception_id;
};
const clear = () => env.ds.query('DELETE FROM calendar_exceptions');

// October 2026: Tue 6, Wed 7, Thu 8, Fri 9, Sat 10, Sun 11, Mon 12, Tue 13.
describe('POST /working-minutes (AC1-AC6, AC13, AC14)', () => {
  before(clear);

  it('AC1: Tue 10:00 to Tue 11:30 = 90', async () => {
    const r = await minutes({ start: '2026-10-06T10:00:00+08:00', end: '2026-10-06T11:30:00+08:00' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { working_minutes: 90 });
  });

  it('AC2: Tue 18:30 to Wed 08:30 = 60', async () => {
    assert.equal((await minutes({ start: '2026-10-06T18:30:00+08:00', end: '2026-10-07T08:30:00+08:00' })).body.working_minutes, 60);
  });

  it('AC3: Fri 18:00 to Tue 09:00 = 660', async () => {
    assert.equal((await minutes({ start: '2026-10-09T18:00:00+08:00', end: '2026-10-13T09:00:00+08:00' })).body.working_minutes, 660);
  });

  it('AC4: with a campus-wide holiday on Wed, Tue 18:00 to Thu 09:00 = 120', async () => {
    const id = await addEntry({ exception_date: '2026-10-07', exception_type: 'REGULAR_HOLIDAY', description: 'Holiday' });
    assert.equal((await minutes({ start: '2026-10-06T18:00:00+08:00', end: '2026-10-08T09:00:00+08:00' })).body.working_minutes, 120);
    await env.ds.query('DELETE FROM calendar_exceptions WHERE exception_id = $1', [id]);
  });

  it('AC5: an office-specific suspension on Wed for office A: office A 120, office B 780', async () => {
    await addEntry({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'Outage', office_id: OFFICE_A });
    const span = { start: '2026-10-06T18:00:00+08:00', end: '2026-10-08T09:00:00+08:00' };
    assert.equal((await minutes({ ...span, officeId: OFFICE_A })).body.working_minutes, 120);
    assert.equal((await minutes({ ...span, officeId: OFFICE_B })).body.working_minutes, 780);
    assert.equal((await minutes(span)).body.working_minutes, 780, 'campus-only when officeId is absent');
    assert.equal((await minutes({ ...span, officeId: null })).body.working_minutes, 780);
    await clear();
  });

  it('AC6: a suspension from 13:00 on Wed, Wed 12:00 to Wed 15:00 = 60', async () => {
    await addEntry({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'Typhoon', suspended_from: '13:00' });
    assert.equal((await minutes({ start: '2026-10-07T12:00:00+08:00', end: '2026-10-07T15:00:00+08:00' })).body.working_minutes, 60);
    await clear();
  });

  it('AC13: an end not after the start returns 400 "End must be after start"', async () => {
    for (const end of ['2026-10-06T10:00:00+08:00', '2026-10-06T09:59:00+08:00', '2026-10-05T10:00:00+08:00']) {
      const r = await minutes({ start: '2026-10-06T10:00:00+08:00', end });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.message, 'End must be after start');
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
      assert.ok(r.body.error.correlation_id && r.body.error.timestamp);
    }
  });

  it('AC14: timestamps in any offset give the same answer, whatever the server clock', async () => {
    const same = [
      ['2026-10-06T10:00:00+08:00', '2026-10-06T11:30:00+08:00'],
      ['2026-10-06T02:00:00Z', '2026-10-06T03:30:00Z'],
      ['2026-10-05T19:00:00-07:00', '2026-10-05T20:30:00-07:00'],
      ['2026-10-06T02:00:00.000Z', '2026-10-06T03:30:00.000Z'],
    ];
    for (const [start, end] of same) assert.equal((await minutes({ start, end })).body.working_minutes, 90, `${start} ${end}`);
    // 23:00Z Tue is 07:00 Wed in Manila.
    assert.equal((await minutes({ start: '2026-10-06T23:00:00Z', end: '2026-10-07T03:00:00Z' })).body.working_minutes, 180);
  });

  it('TT1 extras over HTTP: same non-working day = 0, before opening to after closing = full window, year end', async () => {
    assert.equal((await minutes({ start: '2026-10-11T09:00:00+08:00', end: '2026-10-11T15:00:00+08:00' })).body.working_minutes, 0);
    assert.equal((await minutes({ start: '2026-10-06T05:00:00+08:00', end: '2026-10-06T23:00:00+08:00' })).body.working_minutes, 660);
    assert.equal((await minutes({ start: '2026-12-30T18:00:00+08:00', end: '2027-01-05T09:00:00+08:00' })).body.working_minutes, 1980);
  });

  it('rejects timestamps without an offset (they would depend on the server clock) and other bad input', async () => {
    for (const start of ['2026-10-06T10:00:00', '2026-10-06', 'tomorrow', 12345, null, undefined, '2026-10-06 10:00:00+08:00']) {
      const r = await minutes({ start, end: '2026-10-06T11:00:00+08:00' });
      assert.equal(r.status, 400, String(start));
      assert.ok(r.body.error.details.start);
    }
    assert.equal((await minutes({ start: '2026-10-06T10:00:00+08:00' })).status, 400);
    assert.equal((await minutes({ start: '2026-10-06T10:00:00+08:00', end: '2026-10-06T11:00:00+08:00', officeId: 'nope' })).status, 400);
    assert.equal((await minutes({ start: '2000-01-01T00:00:00+08:00', end: '2026-01-01T00:00:00+08:00' })).status, 400);
  });

  it('needs the service key or a signed-in token', async () => {
    const body = { start: '2026-10-06T10:00:00+08:00', end: '2026-10-06T11:30:00+08:00' };
    assert.equal((await minutes(body, {})).status, 401);
    assert.equal((await minutes(body, { key: 'wrong' })).status, 401);
    for (const token of Object.values(tokens)) assert.equal((await minutes(body, { token })).status, 200);
  });
});

describe('POST /deadline (AC7-AC12)', () => {
  before(clear);
  const ask = async (start, workingDays, extra = {}) => (await deadline({ start, workingDays, ...extra })).body.deadline;

  it('AC7: start Tue 15:00, 3 working days: Fri 19:00', async () => {
    const r = await deadline({ start: '2026-10-06T15:00:00+08:00', workingDays: 3 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { deadline: '2026-10-09T19:00:00+08:00' });
  });

  it('AC8: start Fri 10:00, 1 working day: Sat 17:00', async () => {
    assert.equal(await ask('2026-10-09T10:00:00+08:00', 1), '2026-10-10T17:00:00+08:00');
  });

  it('AC9: start Fri 10:00, 2 working days: Tue 19:00', async () => {
    assert.equal(await ask('2026-10-09T10:00:00+08:00', 2), '2026-10-13T19:00:00+08:00');
  });

  it('AC10: start Tue 15:00, 3 working days, holiday on Thu: Sat 17:00', async () => {
    await addEntry({ exception_date: '2026-10-08', exception_type: 'REGULAR_HOLIDAY', description: 'Holiday' });
    assert.equal(await ask('2026-10-06T15:00:00+08:00', 3), '2026-10-10T17:00:00+08:00');
    await clear();
  });

  it('AC11: start Tue 15:00, 3 working days, 120 held minutes: Sat 10:00', async () => {
    assert.equal(await ask('2026-10-06T15:00:00+08:00', 3, { heldMinutes: 120 }), '2026-10-10T10:00:00+08:00');
  });

  it('AC12: start Sun 10:00, 1 working day: Tue 19:00', async () => {
    assert.equal(await ask('2026-10-11T10:00:00+08:00', 1), '2026-10-13T19:00:00+08:00');
  });

  it('answers in +08:00 whatever offset the start came in, with an office', async () => {
    assert.equal(await ask('2026-10-06T07:00:00Z', 3), '2026-10-09T19:00:00+08:00'); // 15:00 Manila
    await addEntry({ exception_date: '2026-10-08', exception_type: 'SUSPENSION', description: 'Outage', office_id: OFFICE_A });
    assert.equal(await ask('2026-10-06T15:00:00+08:00', 3, { officeId: OFFICE_A }), '2026-10-10T17:00:00+08:00');
    assert.equal(await ask('2026-10-06T15:00:00+08:00', 3, { officeId: OFFICE_B }), '2026-10-09T19:00:00+08:00');
    await clear();
  });

  it('a deadline crosses a year end', async () => {
    assert.equal(await ask('2026-12-30T10:00:00+08:00', 3), '2027-01-02T17:00:00+08:00');
  });

  it('validates workingDays, heldMinutes, start and officeId', async () => {
    const start = '2026-10-06T15:00:00+08:00';
    for (const workingDays of [0, -2, 1.5, '3', null, undefined]) assert.equal((await deadline({ start, workingDays })).status, 400, String(workingDays));
    for (const heldMinutes of [-1, 2.5, 'x']) assert.equal((await deadline({ start, workingDays: 1, heldMinutes })).status, 400, String(heldMinutes));
    assert.equal((await deadline({ start: '2026-10-06T15:00:00', workingDays: 1 })).status, 400);
    assert.equal((await deadline({ start, workingDays: 1, officeId: 'nope' })).status, 400);
    assert.equal((await deadline({ start, workingDays: 1, heldMinutes: null })).status, 200);
  });

  it('needs the service key or a signed-in token', async () => {
    const body = { start: '2026-10-06T15:00:00+08:00', workingDays: 3 };
    assert.equal((await deadline(body, {})).status, 401);
    assert.equal((await deadline(body, { token: tokens.executive })).status, 200);
  });
});

describe('GET /is-working-day', () => {
  before(clear);

  it('returns the window of a working day, a cut window, and null for a non-working day', async () => {
    assert.deepEqual((await day('?date=2026-10-06')).body, { is_working_day: true, window: { opening_time: '08:00', closing_time: '19:00' } });
    assert.deepEqual((await day('?date=2026-10-10')).body, { is_working_day: true, window: { opening_time: '08:00', closing_time: '17:00' } });
    assert.deepEqual((await day('?date=2026-10-11')).body, { is_working_day: false, window: null });
    await addEntry({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'x', suspended_from: '13:00', office_id: OFFICE_A });
    assert.deepEqual((await day(`?date=2026-10-07&officeId=${OFFICE_A}`)).body.window, { opening_time: '08:00', closing_time: '13:00' });
    assert.deepEqual((await day(`?date=2026-10-07&officeId=${OFFICE_B}`)).body.window, { opening_time: '08:00', closing_time: '19:00' });
    await addEntry({ exception_date: '2026-10-08', exception_type: 'REGULAR_HOLIDAY', description: 'x' });
    assert.deepEqual((await day('?date=2026-10-08')).body, { is_working_day: false, window: null });
    await clear();
  });

  it('validates the date and office, and needs a credential', async () => {
    assert.equal((await day('')).status, 400);
    assert.equal((await day('?date=2026-02-30')).status, 400);
    assert.equal((await day('?date=2026-10-06&officeId=x')).status, 400);
    assert.equal((await day('?date=2026-10-06', {})).status, 401);
    assert.equal((await day('?date=2026-10-06', { token: tokens.officeStaffA })).status, 200);
  });
});

describe('AC15: spans up to 60 days return within 2 seconds', () => {
  it('answers a 60-day span and a 60-working-day deadline over HTTP, with a year of entries, quickly', async () => {
    await clear();
    for (let m = 1; m <= 12; m += 1) {
      await addEntry({ exception_date: `2026-${String(m).padStart(2, '0')}-15`, exception_type: 'SPECIAL_NON_WORKING', description: `h${m}` });
    }
    let started = Date.now();
    const r = await minutes({ start: '2026-08-01T00:00:00+08:00', end: '2026-09-30T23:59:00+08:00', officeId: OFFICE_A });
    assert.equal(r.status, 200);
    assert.ok(r.body.working_minutes > 0);
    assert.ok(Date.now() - started < 2000, 'working minutes took too long');
    started = Date.now();
    const d = await deadline({ start: '2026-08-01T10:00:00+08:00', workingDays: 60, heldMinutes: 3000, officeId: OFFICE_A });
    assert.equal(d.status, 200);
    assert.ok(Date.now() - started < 2000, 'deadline took too long');
    await clear();
  });
});

runBoundarySuite({
  name: 'engine endpoints',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'POST /working-minutes',
      write: false,
      officeScoped: true,
      invoke: (token, target) =>
        postMinutes(req('POST', '/working-minutes', { token, body: { start: '2026-10-06T10:00:00+08:00', end: '2026-10-06T11:00:00+08:00', officeId: target === 'own' ? OFFICE_A : OFFICE_B } })),
    },
    {
      name: 'POST /deadline',
      write: false,
      officeScoped: true,
      invoke: (token, target) =>
        postDeadline(req('POST', '/deadline', { token, body: { start: '2026-10-06T10:00:00+08:00', workingDays: 1, officeId: target === 'own' ? OFFICE_A : OFFICE_B } })),
    },
    {
      name: 'GET /is-working-day',
      write: false,
      officeScoped: true,
      invoke: (token, target) => isWorkingDay(req('GET', `/is-working-day?date=2026-10-06&officeId=${target === 'own' ? OFFICE_A : OFFICE_B}`, { token })),
    },
  ],
});
