import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { GET as getSchedule, PUT as putSchedule } from '../src/app/api/schedule/route.js';
import { GET as getHistory } from '../src/app/api/schedule/history/route.js';
import { CHARTER_DAYS, DEFAULT_DAYS, SERVICE_KEY, day, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(async () => env?.teardown());

const put = (days, token = tokens.superAdmin) => putSchedule(req('PUT', '/schedule', { token, body: { days } }));
const get = (token = tokens.superAdmin) => getSchedule(req('GET', '/schedule', { token }));
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);

describe('working hours version history', () => {
  it('lists each saved version newest first, with its schedule, time and role; unchanged saves add none', async () => {
    await env.ds.query(`DELETE FROM audit_outbox WHERE payload->>'action' = 'WORKING_HOURS_UPDATED'`);
    await put(DEFAULT_DAYS);
    const empty = await (await getHistory(req('GET', '/schedule/history', { token: tokens.superAdmin }))).json();
    assert.deepEqual(empty, { items: [], total: 0 });
    await put(CHARTER_DAYS);
    await put(CHARTER_DAYS);
    await put(DEFAULT_DAYS);
    const history = await (await getHistory(req('GET', '/schedule/history', { token: tokens.superAdmin }))).json();
    assert.equal(history.total, 2);
    assert.deepEqual(history.items.map((h) => h.version_no), [2, 1]);
    assert.deepEqual(history.items[0].items, DEFAULT_DAYS);
    assert.deepEqual(history.items[1].items, CHARTER_DAYS);
    assert.equal(history.items[0].actor_role, 'super_admin');
    assert.match(history.items[0].occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('is Super Admin only: other roles 403, no token 401', async () => {
    for (const token of [tokens.executive, tokens.officeHeadA, tokens.officeStaffA]) {
      assert.equal((await getHistory(req('GET', '/schedule/history', { token }))).status, 403);
    }
    assert.equal((await getHistory(req('GET', '/schedule/history'))).status, 401);
  });
});

describe('working hours (CC014)', () => {
  it('seeds seven rows and serves the default: Mon-Fri 08:00-17:00, Sat/Sun non-working', async () => {
    const [{ count }] = await env.ds.query('SELECT count(*)::int AS count FROM working_hours');
    assert.equal(count, 7);
    const response = await get();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, DEFAULT_DAYS);
  });

  it('reseeds itself if the table was emptied', async () => {
    await env.ds.query('DELETE FROM working_hours');
    assert.deepEqual((await (await get()).json()).items, DEFAULT_DAYS);
  });

  it('GET works for every signed-in role and for the service key, and needs one of them', async () => {
    for (const token of Object.values(env.tokens)) assert.equal((await get(token)).status, 200);
    assert.equal((await getSchedule(req('GET', '/schedule', { key: SERVICE_KEY }))).status, 200);
    assert.equal((await getSchedule(req('GET', '/schedule'))).status, 401);
    assert.equal((await getSchedule(req('GET', '/schedule', { key: 'wrong' }))).status, 401);
  });

  it('AC1: Tue-Fri 08:00-19:00, Sat 08:00-17:00 and Sun/Mon non-working saves and shows exactly that', async () => {
    const response = await put(CHARTER_DAYS);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, CHARTER_DAYS);
    assert.deepEqual((await (await get()).json()).items, CHARTER_DAYS);
  });

  it('accepts the days in any order and returns them Sunday first', async () => {
    const response = await put([...CHARTER_DAYS].reverse());
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, CHARTER_DAYS);
  });

  it('AC2: a closing time not after its opening time is rejected', async () => {
    for (const [open, close] of [['09:00', '09:00'], ['17:00', '08:00']]) {
      const days = CHARTER_DAYS.map((d) => (d.day_of_week === 3 ? day(3, true, open, close) : d));
      const response = await put(days);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.message, 'Closing time must be after opening time');
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
    assert.deepEqual((await (await get()).json()).items, CHARTER_DAYS, 'nothing changed');
  });

  it('AC3: setting every day non-working is rejected', async () => {
    const response = await put([0, 1, 2, 3, 4, 5, 6].map((d) => day(d, false)));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.message, 'At least one working day is required');
    assert.deepEqual((await (await get()).json()).items, CHARTER_DAYS, 'nothing changed');
  });

  it('validates the shape: 24-hour HH:MM, required on working days, empty on non-working days', async () => {
    const withDay3 = (replacement) => CHARTER_DAYS.map((d) => (d.day_of_week === 3 ? replacement : d));
    const cases = [
      [withDay3({ day_of_week: 3, is_working: true, opening_time: '8:00', closing_time: '17:00' }), 'Times must be in 24-hour HH:MM format'],
      [withDay3({ day_of_week: 3, is_working: true, opening_time: '08:00', closing_time: '24:00' }), 'Times must be in 24-hour HH:MM format'],
      [withDay3({ day_of_week: 3, is_working: true, opening_time: '08:00 AM', closing_time: '05:00 PM' }), 'Times must be in 24-hour HH:MM format'],
      [withDay3({ day_of_week: 3, is_working: true, opening_time: null, closing_time: '17:00' }), 'Opening and closing times are required on a working day'],
      [withDay3({ day_of_week: 3, is_working: true }), 'Opening and closing times are required on a working day'],
      [withDay3({ day_of_week: 3, is_working: false, opening_time: '08:00', closing_time: '17:00' }), 'Opening and closing times must be empty on a non-working day'],
      [withDay3({ day_of_week: 3, is_working: 'yes', opening_time: '08:00', closing_time: '17:00' }), 'is_working must be true or false for every day'],
      [withDay3({ day_of_week: 7, is_working: false }), 'day_of_week must be a whole number from 0 (Sunday) to 6 (Saturday)'],
      [CHARTER_DAYS.slice(0, 6), 'days must list all 7 days of the week'],
      [CHARTER_DAYS.map((d) => (d.day_of_week === 6 ? { ...d, day_of_week: 5 } : d)), 'Each day of the week must appear exactly once'],
    ];
    for (const [days, message] of cases) {
      const response = await put(days);
      assert.equal(response.status, 400, message);
      assert.equal((await response.json()).error.message, message);
    }
    const missing = await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: {} }));
    assert.equal(missing.status, 400);
    const empty = await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS.map((d) => ({ ...d, opening_time: d.is_working ? d.opening_time : '' , closing_time: d.is_working ? d.closing_time : '' })) } }));
    assert.equal(empty.status, 200, 'empty strings count as empty on a non-working day');
  });

  it('AC4: Office Head, Office Staff and Executive get 403; no token is 401; nothing changes', async () => {
    const other = CHARTER_DAYS.map((d) => (d.day_of_week === 6 ? day(6, false) : d));
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await put(other, token)).status, 403);
    }
    assert.equal((await putSchedule(req('PUT', '/schedule', { body: { days: other } }))).status, 401);
    assert.equal((await putSchedule(req('PUT', '/schedule', { key: SERVICE_KEY, body: { days: other } }))).status, 401);
    assert.deepEqual((await (await get()).json()).items, CHARTER_DAYS);
  });

  it('audits WORKING_HOURS_UPDATED with before and after in the same transaction as the change', async () => {
    await env.ds.query('DELETE FROM audit_outbox');
    const days = CHARTER_DAYS.map((d) => (d.day_of_week === 6 ? day(6, true, '09:00', '12:00') : d));
    assert.equal((await put(days)).status, 200);
    const rows = await audits('WORKING_HOURS_UPDATED');
    assert.equal(rows.length, 1);
    const event = rows[0].payload;
    assert.equal(event.entity_type, 'working_hours');
    assert.equal(event.office_id, null);
    assert.equal(event.actor_role, 'super_admin');
    assert.deepEqual(event.before_value.items, CHARTER_DAYS);
    assert.deepEqual(event.after_value.items, days);
  });

  it('saving the same schedule again is a no-op: no audit entry and no push', async () => {
    const current = (await (await get()).json()).items;
    await env.ds.query('DELETE FROM audit_outbox');
    await env.ds.query('DELETE FROM sync_log');
    assert.equal((await put(current)).status, 200);
    assert.equal((await audits('WORKING_HOURS_UPDATED')).length, 0);
    assert.equal((await env.ds.query('SELECT 1 FROM sync_log')).length, 0);
  });

  it('a change queues one FMS row and one Audit row', async () => {
    await env.ds.query('DELETE FROM sync_log');
    assert.equal((await put(CHARTER_DAYS)).status, 200);
    const rows = await env.ds.query('SELECT consumer_system, event_type, status FROM sync_log ORDER BY consumer_system');
    assert.deepEqual(rows, [
      { consumer_system: 'AUDIT', event_type: 'WORKING_HOURS_UPDATED', status: 'PENDING' },
      { consumer_system: 'FMS', event_type: 'WORKING_HOURS_UPDATED', status: 'PENDING' },
    ]);
  });

  it('the database itself refuses a bad schedule row', async () => {
    await assert.rejects(env.ds.query(`UPDATE working_hours SET opening_time = '18:00', closing_time = '09:00' WHERE day_of_week = 2`));
    await assert.rejects(env.ds.query(`UPDATE working_hours SET is_working = false WHERE day_of_week = 2`));
  });
});

runBoundarySuite({
  name: 'calendar schedule',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'PUT /schedule',
      write: true,
      superAdminOnly: true,
      officeScoped: false,
      invoke: (token) => put(CHARTER_DAYS, token),
    },
    {
      name: 'GET /schedule',
      write: false,
      officeScoped: false,
      invoke: (token) => get(token),
    },
  ],
});
