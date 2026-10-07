import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { POST as postDeadline } from '../src/app/api/deadline/route.js';
import { GET as getHolidays } from '../src/app/api/holidays/route.js';
import { DELETE as deleteRoute, PUT as putRoute } from '../src/app/api/exceptions/[id]/route.js';
import { GET as listRoute, POST as postRoute } from '../src/app/api/exceptions/route.js';
import { GET as isWorkingDay } from '../src/app/api/is-working-day/route.js';
import { POST as postMinutes } from '../src/app/api/working-minutes/route.js';
import { PUT as putSchedule } from '../src/app/api/schedule/route.js';
import { CHARTER_DAYS, OFFICE_A, OFFICE_B, SERVICE_KEY, ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  const saved = await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }));
  assert.equal(saved.status, 200);
});
after(async () => env?.teardown());

const add = async (body, token = tokens.superAdmin) => {
  const response = await postRoute(req('POST', '/exceptions', { token, body }));
  return { response, body: await response.json() };
};
const holiday = (exception_date, extra = {}) => ({ exception_date, exception_type: 'REGULAR_HOLIDAY', description: 'Holiday', ...extra });
const minutes = async (start, end, officeId) => {
  const response = await postMinutes(req('POST', '/working-minutes', { key: SERVICE_KEY, body: { start, end, ...(officeId ? { officeId } : {}) } }));
  assert.equal(response.status, 200);
  return (await response.json()).working_minutes;
};
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const remove = (id, token = tokens.superAdmin) => deleteRoute(req('DELETE', `/exceptions/${id}`, { token }), ctx(id));

// October 2026 with the charter schedule: Tue 6, Wed 7, Thu 8 (Tue-Fri 08:00-19:00).
describe('holidays and suspensions (CC015)', () => {
  it('creates the table with the NULLS NOT DISTINCT unique index on (office_id, exception_date)', async () => {
    const [index] = await env.ds.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'calendar_exceptions_scope_date_uq'`);
    assert.match(index.indexdef, /UNIQUE/);
    assert.match(index.indexdef, /office_id, exception_date/);
    assert.match(index.indexdef, /NULLS NOT DISTINCT/);
  });

  it('the database alone stops two campus-wide entries on one date (a plain unique index would not)', async () => {
    const insert = () =>
      env.ds.query(`INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, description, is_recurring) VALUES ($1, '2031-03-03', 'REGULAR_HOLIDAY', 'x', false)`, [randomUUID()]);
    await insert();
    await assert.rejects(insert(), (err) => err.code === '23505');
    await env.ds.query(`DELETE FROM calendar_exceptions WHERE exception_date = '2031-03-03'`);
  });

  it('AC1: a campus-wide REGULAR_HOLIDAY removes that date for every office; AC10: removing it restores the date', async () => {
    const { response, body } = await add(holiday('2026-10-07'));
    assert.equal(response.status, 201);
    assert.equal(body.exception.exception_type, 'REGULAR_HOLIDAY');
    assert.equal(body.exception.office_id, null);
    assert.equal(body.exception.suspended_from, null);
    assert.equal(body.exception.is_recurring, false);
    assert.ok(body.exception.exception_id && body.exception.created_at);

    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00'), 120);
    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00', OFFICE_A), 120);
    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00', OFFICE_B), 120);

    const id = body.exception.exception_id;
    await env.ds.query('DELETE FROM audit_outbox');
    const removed = await remove(id);
    assert.equal(removed.status, 204);
    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00'), 780);

    const [event] = (await audits('CALENDAR_EXCEPTION_REMOVED')).map((r) => r.payload);
    assert.equal(event.entity_id, id);
    assert.equal(event.before_value.exception_date, '2026-10-07');
    assert.equal(event.before_value.exception_type, 'REGULAR_HOLIDAY');
    assert.equal(event.after_value, null);
    assert.equal(event.office_id, null);
  });

  it('AC2: an office-specific SUSPENSION for office A removes the day only for office A', async () => {
    const { response, body } = await add({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'Power outage', office_id: OFFICE_A });
    assert.equal(response.status, 201);
    assert.equal(body.exception.office_id, OFFICE_A);
    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00', OFFICE_A), 120);
    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00', OFFICE_B), 780);
    assert.equal(await minutes('2026-10-06T18:00:00+08:00', '2026-10-08T09:00:00+08:00'), 780);
    const check = async (officeId) => (await (await isWorkingDay(req('GET', `/is-working-day?date=2026-10-07${officeId ? `&officeId=${officeId}` : ''}`, { key: SERVICE_KEY }))).json()).is_working_day;
    assert.equal(await check(OFFICE_A), false);
    assert.equal(await check(OFFICE_B), true);
    await remove(body.exception.exception_id);
  });

  it('AC3: a suspension from 13:00 leaves working time only from opening until 13:00', async () => {
    const { response, body } = await add({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'Typhoon', suspended_from: '13:00' });
    assert.equal(response.status, 201);
    assert.equal(body.exception.suspended_from, '13:00');
    assert.equal(await minutes('2026-10-07T12:00:00+08:00', '2026-10-07T15:00:00+08:00'), 60);
    assert.equal(await minutes('2026-10-07T05:00:00+08:00', '2026-10-07T23:00:00+08:00'), 300);
    const day = await (await isWorkingDay(req('GET', '/is-working-day?date=2026-10-07', { key: SERVICE_KEY }))).json();
    assert.deepEqual(day, { is_working_day: true, window: { opening_time: '08:00', closing_time: '13:00' } });
    await remove(body.exception.exception_id);
  });

  it('AC4: a second entry for the same date and scope is rejected with 409', async () => {
    const first = await add(holiday('2026-11-03'));
    assert.equal(first.response.status, 201);
    for (const extra of [{}, { exception_type: 'SPECIAL_NON_WORKING' }, { exception_type: 'SUSPENSION', suspended_from: '10:00' }]) {
      const again = await add(holiday('2026-11-03', extra));
      assert.equal(again.response.status, 409);
      assert.equal(again.body.error.message, 'An entry already exists for this date and scope');
    }
    // A different scope for the same date is fine: office A, then office B.
    assert.equal((await add(holiday('2026-11-03', { office_id: OFFICE_A }))).response.status, 201);
    assert.equal((await add(holiday('2026-11-03', { office_id: OFFICE_B }))).response.status, 201);
    const again = await add(holiday('2026-11-03', { office_id: OFFICE_A, exception_type: 'LOCAL_HOLIDAY' }));
    assert.equal(again.response.status, 409);
  });

  it('AC5: a recurring holiday anchored in 2026 is non-working on Jan 1 of 2026 and later years, not before', async () => {
    const { response, body } = await add(holiday('2026-01-01', { description: "New Year's Day", is_recurring: true }));
    assert.equal(response.status, 201);
    assert.equal(body.exception.is_recurring, true);
    const working = async (date) => (await (await isWorkingDay(req('GET', `/is-working-day?date=${date}`, { key: SERVICE_KEY }))).json()).is_working_day;
    assert.equal(await working('2025-01-01'), true); // Wed
    assert.equal(await working('2026-01-01'), false); // Thu
    assert.equal(await working('2027-01-01'), false); // Fri
    assert.equal(await working('2030-01-01'), false); // Tue
    await remove(body.exception.exception_id); // AC9
  });

  it('AC6: a recurring SUSPENSION is rejected with "Suspensions cannot be recurring"', async () => {
    const { response, body } = await add({ exception_date: '2026-09-01', exception_type: 'SUSPENSION', description: 'x', is_recurring: true });
    assert.equal(response.status, 400);
    assert.equal(body.error.message, 'Suspensions cannot be recurring');
    const update = await add(holiday('2026-09-02'));
    const put = await putRoute(req('PUT', `/exceptions/${update.body.exception.exception_id}`, { token: tokens.superAdmin, body: { exception_date: '2026-09-02', exception_type: 'SUSPENSION', description: 'x', is_recurring: true } }), ctx(update.body.exception.exception_id));
    assert.equal(put.status, 400);
    assert.equal((await put.json()).error.message, 'Suspensions cannot be recurring');
    await assert.rejects(
      env.ds.query(`INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, is_recurring) VALUES ($1, '2031-04-04', 'SUSPENSION', true)`, [randomUUID()]),
      'the database refuses it too',
    );
  });

  it('AC7: a one-time entry on a date covered by a recurring entry of the same scope is rejected', async () => {
    const recurring = await add(holiday('2026-12-25', { description: 'Christmas Day', is_recurring: true }));
    assert.equal(recurring.response.status, 201);
    for (const date of ['2026-12-25', '2027-12-25', '2040-12-25']) {
      const { response, body } = await add(holiday(date, { exception_type: 'SPECIAL_NON_WORKING' }));
      assert.equal(response.status, 409, date);
      assert.equal(body.error.message, 'An entry already exists for this date and scope');
    }
    // Another scope, or a date before the recurring entry's anchor year, is not covered.
    assert.equal((await add(holiday('2027-12-25', { office_id: OFFICE_A }))).response.status, 201);
    assert.equal((await add(holiday('2025-12-25'))).response.status, 201);
    // A second recurring entry on the same month and day is rejected, and so is a one-time entry added first.
    assert.equal((await add(holiday('2028-12-25', { is_recurring: true }))).response.status, 409);
    const oneTime = await add(holiday('2029-06-12'));
    assert.equal(oneTime.response.status, 201);
    assert.equal((await add(holiday('2026-06-12', { is_recurring: true }))).response.status, 409, 'would cover the 2029 entry');
    assert.equal((await add(holiday('2030-06-12', { is_recurring: true }))).response.status, 201, 'starts after the 2029 entry');
  });

  it('AC8: a recurring Feb 29 entry applies only in leap years', async () => {
    const { response, body } = await add(holiday('2028-02-29', { description: 'Leap day', is_recurring: true }));
    assert.equal(response.status, 201);
    const working = async (date) => (await (await isWorkingDay(req('GET', `/is-working-day?date=${date}`, { key: SERVICE_KEY }))).json()).is_working_day;
    assert.equal(await working('2028-02-29'), false); // Tue
    assert.equal(await working('2032-02-29'), false); // Sun anyway: check the engine's holidays list below
    assert.equal(await working('2029-02-28'), true); // Wed
    assert.equal(await working('2029-03-01'), true); // Thu
    const list = await (await getHolidays(req('GET', '/holidays?from=2028-01-01&to=2037-12-31', { key: SERVICE_KEY }))).json();
    assert.deepEqual(
      list.items.filter((i) => i.description === 'Leap day').map((i) => i.date),
      ['2028-02-29', '2032-02-29', '2036-02-29'],
    );
    await remove(body.exception.exception_id);
  });

  it('AC9: removing a recurring entry removes it for every year and is audited', async () => {
    const { body } = await add(holiday('2026-05-01', { description: 'Labor Day', is_recurring: true }));
    const id = body.exception.exception_id;
    const before = await (await getHolidays(req('GET', '/holidays?from=2026-01-01&to=2029-12-31', { key: SERVICE_KEY }))).json();
    assert.equal(before.items.filter((i) => i.description === 'Labor Day').length, 4);
    await env.ds.query('DELETE FROM audit_outbox');
    assert.equal((await remove(id)).status, 204);
    const after = await (await getHolidays(req('GET', '/holidays?from=2026-01-01&to=2029-12-31', { key: SERVICE_KEY }))).json();
    assert.equal(after.items.filter((i) => i.description === 'Labor Day').length, 0);
    const [event] = (await audits('CALENDAR_EXCEPTION_REMOVED')).map((r) => r.payload);
    assert.equal(event.before_value.is_recurring, true);
    assert.equal(event.before_value.exception_date, '2026-05-01');
  });

  it('AC11: a suspended_from time outside that day\'s working hours is rejected', async () => {
    const attempt = async (exception_date, suspended_from) =>
      add({ exception_date, exception_type: 'SUSPENSION', description: 'x', suspended_from });
    // Wed 2026-10-14 is 08:00-19:00.
    for (const time of ['07:59', '19:00', '19:30', '23:00', '00:00']) {
      const { response, body } = await attempt('2026-10-14', time);
      assert.equal(response.status, 400, time);
      assert.match(body.error.message, /working hours/);
    }
    // A non-working day (Monday) has no hours at all.
    const monday = await attempt('2026-10-12', '10:00');
    assert.equal(monday.response.status, 400);
    assert.match(monday.body.error.message, /not a working day/);
    // The boundaries inside the window are fine.
    assert.equal((await attempt('2026-10-14', '08:00')).response.status, 201);
    assert.equal((await attempt('2026-10-15', '18:59')).response.status, 201);
    // Saturday closes at 17:00.
    assert.equal((await attempt('2026-10-17', '17:00')).response.status, 400);
    assert.equal((await attempt('2026-10-17', '16:59')).response.status, 201);
    // Bad format.
    assert.equal((await attempt('2026-10-21', '9:00')).response.status, 400);
    assert.equal((await attempt('2026-10-21', '25:00')).response.status, 400);
  });

  it('AC12: Office Head, Office Staff and Executive get 403 on every change', async () => {
    const { body } = await add(holiday('2027-03-03'));
    const id = body.exception.exception_id;
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await add(holiday('2027-03-04'), token)).response.status, 403);
      assert.equal((await putRoute(req('PUT', `/exceptions/${id}`, { token, body: holiday('2027-03-03') }), ctx(id))).status, 403);
      assert.equal((await remove(id, token)).status, 403);
    }
    assert.equal((await postRoute(req('POST', '/exceptions', { body: holiday('2027-03-04') }))).status, 401);
    assert.equal((await postRoute(req('POST', '/exceptions', { key: SERVICE_KEY, body: holiday('2027-03-04') }))).status, 401);
    assert.equal((await listRoute(req('GET', '/exceptions', { token: tokens.superAdmin }))).status, 200);
  });

  it('validates the fields and uses the standard error format', async () => {
    const cases = [
      [{}, ['exception_date', 'exception_type']],
      [holiday('2026-02-30'), ['exception_date']],
      [holiday('26-01-01'), ['exception_date']],
      [holiday('2026-01-01', { exception_type: 'PARTY' }), ['exception_type']],
      [holiday('2026-01-01', { office_id: 'nope' }), ['office_id']],
      [holiday('2026-01-01', { description: 'x'.repeat(201) }), ['description']],
      [holiday('2026-01-01', { is_recurring: 'yes' }), ['is_recurring']],
    ];
    for (const [body, fields] of cases) {
      const { response, body: error } = await add(body);
      assert.equal(response.status, 400);
      assert.equal(error.error.code, 'VALIDATION_ERROR');
      for (const field of fields) assert.ok(error.error.details[field], `${field} should be flagged`);
      assert.ok(error.error.correlation_id && error.error.timestamp);
    }
    const invalid = await postRoute(new Request('http://localhost/api/exceptions', { method: 'POST', headers: { authorization: `Bearer ${tokens.superAdmin}`, 'content-type': 'application/json' }, body: '{nope' }));
    assert.equal(invalid.status, 400);
  });

  it('allows past dates (completed results are not recomputed)', async () => {
    const { response } = await add(holiday('2019-06-12', { description: 'Independence Day' }));
    assert.equal(response.status, 201);
  });

  it('a suspension that becomes invalid after a schedule change is still applied safely', async () => {
    const { body } = await add({ exception_date: '2026-11-17', exception_type: 'SUSPENSION', description: 'x', suspended_from: '18:00' });
    assert.equal(body.exception.suspended_from, '18:00');
    // Shorten Tuesdays so 18:00 is now after closing: the cut changes nothing, nothing crashes.
    const days = CHARTER_DAYS.map((d) => (d.day_of_week === 2 ? { ...d, closing_time: '16:00' } : d));
    assert.equal((await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days } }))).status, 200);
    assert.equal(await minutes('2026-11-17T08:00:00+08:00', '2026-11-17T23:00:00+08:00'), 480);
    assert.equal((await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }))).status, 200);
  });

  it('PUT replaces an entry, can change its scope, keeps the one-per-scope rule and is audited', async () => {
    const { body } = await add(holiday('2027-04-06', { description: 'Before' }));
    const id = body.exception.exception_id;
    await add(holiday('2027-04-07'));
    await env.ds.query('DELETE FROM audit_outbox');

    const ok = await putRoute(req('PUT', `/exceptions/${id}`, { token: tokens.superAdmin, body: holiday('2027-04-06', { description: 'After', office_id: OFFICE_A, exception_type: 'LOCAL_HOLIDAY' }) }), ctx(id));
    assert.equal(ok.status, 200);
    const updated = (await ok.json()).exception;
    assert.deepEqual([updated.description, updated.office_id, updated.exception_type], ['After', OFFICE_A, 'LOCAL_HOLIDAY']);
    const [event] = (await audits('CALENDAR_EXCEPTION_UPDATED')).map((r) => r.payload);
    assert.equal(event.before_value.description, 'Before');
    assert.equal(event.after_value.description, 'After');
    assert.equal(event.office_id, OFFICE_A);

    // Moving onto a date that already has an entry in that scope is refused; staying put is not a conflict with itself.
    const clash = await putRoute(req('PUT', `/exceptions/${id}`, { token: tokens.superAdmin, body: holiday('2027-04-07', { office_id: null }) }), ctx(id));
    assert.equal(clash.status, 409);
    assert.equal((await clash.json()).error.message, 'An entry already exists for this date and scope');
    const same = await putRoute(req('PUT', `/exceptions/${id}`, { token: tokens.superAdmin, body: holiday('2027-04-06', { description: 'After', office_id: OFFICE_A, exception_type: 'LOCAL_HOLIDAY' }) }), ctx(id));
    assert.equal(same.status, 200);
    assert.equal((await audits('CALENDAR_EXCEPTION_UPDATED')).length, 1, 'an unchanged save writes no audit entry');

    const missing = randomUUID();
    assert.equal((await putRoute(req('PUT', `/exceptions/${missing}`, { token: tokens.superAdmin, body: holiday('2027-04-08') }), ctx(missing))).status, 404);
    assert.equal((await putRoute(req('PUT', '/exceptions/not-a-uuid', { token: tokens.superAdmin, body: holiday('2027-04-08') }), ctx('not-a-uuid'))).status, 404);
    assert.equal((await remove(missing)).status, 404);
  });

  it('audits every add with the exception\'s office (null for campus-wide) in the same transaction', async () => {
    await env.ds.query('DELETE FROM audit_outbox');
    const campus = await add(holiday('2027-06-01'));
    const office = await add(holiday('2027-06-01', { office_id: OFFICE_B }));
    const events = (await audits('CALENDAR_EXCEPTION_ADDED')).map((r) => r.payload);
    assert.equal(events.length, 2);
    assert.equal(events[0].entity_id, campus.body.exception.exception_id);
    assert.equal(events[0].office_id, null);
    assert.equal(events[1].office_id, OFFICE_B);
    assert.equal(events[1].after_value.exception_id, office.body.exception.exception_id);
    assert.equal(events[0].before_value, null);
    // A rejected save leaves no audit entry and no push behind.
    await env.ds.query('DELETE FROM audit_outbox');
    const syncBefore = (await env.ds.query('SELECT count(*)::int AS n FROM sync_log'))[0].n;
    assert.equal((await add(holiday('2027-06-01'))).response.status, 409);
    assert.equal((await audits('CALENDAR_EXCEPTION_ADDED')).length, 0);
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM sync_log'))[0].n, syncBefore);
  });

  it('each change queues one FMS row and one Audit row', async () => {
    await env.ds.query('DELETE FROM sync_log');
    const { body } = await add(holiday('2027-07-01'));
    let rows = await env.ds.query('SELECT consumer_system, event_type FROM sync_log ORDER BY consumer_system');
    assert.deepEqual(rows, [
      { consumer_system: 'AUDIT', event_type: 'CALENDAR_EXCEPTION_ADDED' },
      { consumer_system: 'FMS', event_type: 'CALENDAR_EXCEPTION_ADDED' },
    ]);
    await remove(body.exception.exception_id);
    rows = await env.ds.query(`SELECT consumer_system FROM sync_log WHERE event_type = 'CALENDAR_EXCEPTION_REMOVED' ORDER BY 1`);
    assert.equal(rows.length, 2);
  });
});

describe('listing exceptions and holidays', () => {
  before(async () => {
    await env.ds.query('DELETE FROM calendar_exceptions');
    await add(holiday('2026-01-01', { description: 'NY', is_recurring: true }));
    await add(holiday('2026-06-12', { description: 'Independence' }));
    await add(holiday('2026-06-12', { description: 'Office A', office_id: OFFICE_A, exception_type: 'LOCAL_HOLIDAY' }));
    await add({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'B only', office_id: OFFICE_B, suspended_from: '13:00' });
    await add(holiday('2028-02-29', { description: 'Leap', is_recurring: true }));
  });

  const list = async (query, token = tokens.superAdmin) => {
    const response = await listRoute(req('GET', `/exceptions${query}`, { token }));
    return { status: response.status, body: await response.json() };
  };
  const holidays = async (query, opts = { key: SERVICE_KEY }) => {
    const response = await getHolidays(req('GET', `/holidays${query}`, opts));
    return { status: response.status, body: await response.json() };
  };

  it('GET /exceptions filters by range, office and type, and is open to every signed-in role', async () => {
    const all = await list('');
    assert.equal(all.body.items.length, 5);
    assert.deepEqual(
      Object.keys(all.body.items[0]).sort(),
      ['created_at', 'description', 'exception_date', 'exception_id', 'exception_type', 'is_recurring', 'office_id', 'suspended_from'],
    );
    assert.deepEqual((await list('?from=2026-06-01&to=2026-06-30')).body.items.map((i) => i.description).sort(), ['Independence', 'Office A']);
    // A recurring entry shows when one of its dates is in the range.
    assert.deepEqual((await list('?from=2030-01-01&to=2030-01-31')).body.items.map((i) => i.description), ['NY']);
    assert.deepEqual((await list('?from=2025-01-01&to=2025-12-31')).body.items, []);
    assert.deepEqual((await list(`?office_id=${OFFICE_B}`)).body.items.map((i) => i.description), ['B only']);
    assert.deepEqual((await list('?type=LOCAL_HOLIDAY')).body.items.map((i) => i.description), ['Office A']);
    assert.equal((await list('?from=bad')).status, 400);
    assert.equal((await list('?type=NOPE')).status, 400);
    assert.equal((await list('?office_id=nope')).status, 400);
    assert.equal((await list('?from=2026-06-30&to=2026-06-01')).status, 400);
    for (const token of Object.values(tokens)) assert.equal((await list('', token)).status, 200);
    assert.equal((await listRoute(req('GET', '/exceptions'))).status, 401);
  });

  it('Office Head and Office Staff see campus-wide entries and their own office only', async () => {
    const seen = (await list('', tokens.officeStaffA)).body.items.map((i) => i.description).sort();
    assert.deepEqual(seen, ['Independence', 'Leap', 'NY', 'Office A']);
    assert.equal((await list(`?office_id=${OFFICE_B}`, tokens.officeHeadA)).status, 403);
    assert.equal((await list(`?office_id=${OFFICE_A}`, tokens.officeHeadA)).status, 200);
  });

  it('GET /holidays expands recurring entries per year and is campus-only without officeId', async () => {
    const { status, body } = await holidays('?from=2026-01-01&to=2027-12-31');
    assert.equal(status, 200);
    assert.deepEqual(body.items, [
      { date: '2026-01-01', exception_type: 'REGULAR_HOLIDAY', description: 'NY', office_id: null, suspended_from: null },
      { date: '2026-06-12', exception_type: 'REGULAR_HOLIDAY', description: 'Independence', office_id: null, suspended_from: null },
      { date: '2027-01-01', exception_type: 'REGULAR_HOLIDAY', description: 'NY', office_id: null, suspended_from: null },
    ]);
  });

  it('GET /holidays with officeId adds that office\'s entries, including suspended_from', async () => {
    const a = await holidays(`?from=2026-06-01&to=2026-06-30&officeId=${OFFICE_A}`);
    assert.deepEqual(a.body.items.map((i) => [i.date, i.description, i.office_id]), [
      ['2026-06-12', 'Independence', null],
      ['2026-06-12', 'Office A', OFFICE_A],
    ]);
    const b = await holidays(`?from=2026-10-01&to=2026-10-31&officeId=${OFFICE_B}`);
    assert.deepEqual(b.body.items, [
      { date: '2026-10-07', exception_type: 'SUSPENSION', description: 'B only', office_id: OFFICE_B, suspended_from: '13:00' },
    ]);
    assert.deepEqual((await holidays('?from=2026-10-01&to=2026-10-31')).body.items, []);
  });

  it('Feb 29 recurring shows only in leap years; nothing before the anchor year', async () => {
    const { body } = await holidays('?from=2024-01-01&to=2033-12-31');
    assert.deepEqual(body.items.filter((i) => i.description === 'Leap').map((i) => i.date), ['2028-02-29', '2032-02-29']);
    assert.deepEqual((await holidays('?from=2025-01-01&to=2025-12-31')).body.items, []);
  });

  it('GET /holidays needs a key or token, valid dates and office access', async () => {
    assert.equal((await holidays('?from=2026-01-01&to=2026-12-31', {})).status, 401);
    assert.equal((await holidays('?from=2026-01-01&to=2026-12-31', { key: 'wrong' })).status, 401);
    assert.equal((await holidays('?from=2026-01-01&to=2026-12-31', { token: tokens.executive })).status, 200);
    assert.equal((await holidays('?to=2026-12-31')).status, 400);
    assert.equal((await holidays('?from=2026-13-01&to=2026-12-31')).status, 400);
    assert.equal((await holidays('?from=2026-12-31&to=2026-01-01')).status, 400);
    assert.equal((await holidays('?from=1990-01-01&to=2026-01-01')).status, 400);
    assert.equal((await holidays(`?from=2026-01-01&to=2026-12-31&officeId=${OFFICE_B}`, { token: tokens.officeStaffA })).status, 403);
    assert.equal((await holidays(`?from=2026-01-01&to=2026-12-31&officeId=${OFFICE_A}`, { token: tokens.officeStaffA })).status, 200);
    assert.equal((await holidays('?from=2026-01-01&to=2026-12-31&officeId=zzz')).status, 400);
  });

  it('holiday changes show up in deadlines straight away (AC10: computed afterwards, not recomputed before)', async () => {
    const ask = async () => (await (await postDeadline(req('POST', '/deadline', { key: SERVICE_KEY, body: { start: '2026-10-06T15:00:00+08:00', workingDays: 3, officeId: OFFICE_B } }))).json()).deadline;
    // Office B has a 13:00 suspension on Wed 2026-10-07, which still counts as a working day.
    assert.equal(await ask(), '2026-10-09T19:00:00+08:00');
    const { body } = await add(holiday('2026-10-08', { description: 'Extra' }));
    assert.equal(await ask(), '2026-10-10T17:00:00+08:00');
    await remove(body.exception.exception_id);
    assert.equal(await ask(), '2026-10-09T19:00:00+08:00');
  });
});

runBoundarySuite({
  name: 'calendar exceptions',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    { name: 'POST /exceptions', write: true, superAdminOnly: true, officeScoped: false, invoke: (token) => postRoute(req('POST', '/exceptions', { token, body: holiday('2035-01-01') })).then(cleanup) },
    { name: 'PUT /exceptions/:id', write: true, superAdminOnly: true, officeScoped: false, invoke: (token) => putRoute(req('PUT', `/exceptions/${randomUUID()}`, { token, body: holiday('2035-01-02') }), ctx(randomUUID())) },
    { name: 'DELETE /exceptions/:id', write: true, superAdminOnly: true, officeScoped: false, invoke: (token) => remove(randomUUID(), token) },
    {
      name: 'GET /exceptions?office_id=',
      write: false,
      officeScoped: true,
      invoke: (token, target) => listRoute(req('GET', `/exceptions?office_id=${target === 'own' ? OFFICE_A : OFFICE_B}`, { token })),
    },
    {
      name: 'GET /holidays?officeId=',
      write: false,
      officeScoped: true,
      invoke: (token, target) =>
        getHolidays(req('GET', `/holidays?from=2026-01-01&to=2026-12-31&officeId=${target === 'own' ? OFFICE_A : OFFICE_B}`, { token })),
    },
  ],
});

async function cleanup(response) {
  if (response.status === 201) {
    const { exception } = await response.clone().json();
    await remove(exception.exception_id);
  }
  return response;
}
