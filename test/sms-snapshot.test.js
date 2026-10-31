// EB17: term snapshot for SMS (built against a stand-in SMS; SMS names are PROPOSED and not confirmed).
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { POST as postException } from '../src/app/api/exceptions/route.js';
import { DELETE as deleteException } from '../src/app/api/exceptions/[id]/route.js';
import { dispatchSyncLogs } from '../src/lib/calendar/sync-dispatch.js';
import { SMS_TYPE_MAP } from '../src/lib/calendar/sms-snapshot.js';
import { ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  await env.ds.query('INSERT INTO catalogue_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
  await env.ds.query('UPDATE catalogue_settings SET applies_to_enabled = true');
});
after(async () => env?.teardown());
beforeEach(async () => {
  await env.ds.query('DELETE FROM sync_log');
  await env.ds.query('DELETE FROM calendar_exceptions');
  await env.ds.query('DELETE FROM term_dates');
  await env.ds.query(`INSERT INTO term_dates (term_id, term_name, start_date, end_date) VALUES (gen_random_uuid(), '2026-1S', '2026-08-17', '2026-12-12')`);
});

const save = async (body) => {
  const response = await postException(req('POST', '/exceptions', { token: tokens.superAdmin, body }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json());
};
const snapshots = () => env.ds.query(`SELECT sync_id, status, attempts, last_error, reply, payload FROM sync_log WHERE entity_type = 'term_snapshot' ORDER BY created_at, sync_id`);
const send = (reply, extra = {}) => {
  const delivered = [];
  const fetchImpl = async (url, init) => {
    delivered.push(JSON.parse(init.body));
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status: extra.status ?? 200 });
  };
  return { delivered, run: () => dispatchSyncLogs(env.ds, { urls: { AUDIT: 'http://sms.test/calendar' }, serviceKey: 'k', retryIntervalMs: 0, maxAttempts: 5, enabledConsumers: ['AUDIT'], fetchImpl }) };
};

describe('EB17 term snapshot for SMS', () => {
  it('AC1: a snapshot lists every entry of the term with its type and applies-to, and only that term', async () => {
    await save({ exception_date: '2026-12-25', exception_type: 'REGULAR_HOLIDAY', description: 'Out of term' });
    await save({ exception_date: '2026-09-21', exception_type: 'SPECIAL_NON_WORKING', description: 'Special day' });
    await save({ exception_date: '2026-10-05', exception_type: 'SUSPENSION', description: 'Part day', suspended_from: '13:00', suspended_until: '17:00', applies_to: 'CLASSES', class_mode: 'ONLINE' });
    const [latest] = (await snapshots()).filter((s) => s.status === 'PENDING');
    const { payload } = latest;
    assert.equal(payload.termCode, '2026-1S');
    assert.deepEqual(payload.items.map((i) => i.date), ['2026-09-21', '2026-10-05']);
    assert.equal(payload.items[0].type, SMS_TYPE_MAP.SPECIAL_NON_WORKING);
    assert.deepEqual(payload.items[0].appliesTo, ['CLASSES', 'WORK']);
    assert.deepEqual(payload.items[1].interval, { start: '2026-10-05T13:00:00+08:00', end: '2026-10-05T17:00:00+08:00', allDay: false });
    assert.deepEqual(payload.items[1].appliesTo, ['CLASSES']);
    assert.equal(payload.items[1].effect, 'ONLINE');
  });

  it('only the newest snapshot of a term is delivered; older undelivered ones are SUPERSEDED', async () => {
    await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    await save({ exception_date: '2026-09-22', exception_type: 'REGULAR_HOLIDAY', description: 'B' });
    const before = await snapshots();
    assert.deepEqual(before.map((s) => s.status), ['SUPERSEDED', 'PENDING']);
    const sms = send({ status: 'SUCCESS', termId: 'T-1', applied: { entries: 2 } });
    await sms.run();
    assert.equal(sms.delivered.filter((m) => m.kind === 'term_snapshot').length, 1);
    assert.equal(sms.delivered.find((m) => m.kind === 'term_snapshot').items.length, 2);
  });

  it('AC2: a success reply (term ID and counts) is stored', async () => {
    await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    const reply = { status: 'SUCCESS', termId: 'T-1', applied: { entries: 1 } };
    await send(reply).run();
    const row = (await snapshots()).find((s) => s.status === 'SENT');
    assert.deepEqual(row.reply, reply);
  });

  it('AC2: a failure reply is stored with its reason and retried until it succeeds', async () => {
    await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    await send({ status: 'FAILED', reason: 'Unknown term code' }).run();
    let row = (await snapshots()).find((s) => s.status === 'FAILED');
    assert.match(row.last_error, /Unknown term code/);
    assert.equal(row.reply.reason, 'Unknown term code');
    assert.equal(row.attempts, 1);
    await send({ status: 'SUCCESS', termId: 'T-1', applied: { entries: 1 } }).run();
    row = (await snapshots())[0];
    assert.equal(row.status, 'SENT');
    assert.equal(row.attempts, 2);
  });

  it('AC3: withdrawing an entry sends a new snapshot without it', async () => {
    const created = await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    await save({ exception_date: '2026-09-22', exception_type: 'REGULAR_HOLIDAY', description: 'B' });
    const id = created.exception?.exception_id ?? created.exception_id ?? created.id;
    const response = await deleteException(req('DELETE', `/exceptions/${id}`, { token: tokens.superAdmin }), ctx(id));
    assert.equal(response.status, 204);
    const newest = (await snapshots()).filter((s) => s.status === 'PENDING').pop().payload;
    assert.deepEqual(newest.items.map((i) => i.date), ['2026-09-22']);
  });

  it('AC4: the same sync ID goes out again unchanged after a failed attempt', async () => {
    await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    const first = send('{}', { status: 503 });
    await first.run();
    const second = send({ status: 'SUCCESS', termId: 'T-1' });
    await second.run();
    const a = first.delivered.find((m) => m.kind === 'term_snapshot');
    const b = second.delivered.find((m) => m.kind === 'term_snapshot');
    assert.equal(a.syncId, b.syncId);
    assert.deepEqual(a, b);
  });

  it('nothing is queued for a term the entry does not fall in, and nothing is sent while SMS is switched off', async () => {
    await save({ exception_date: '2027-03-01', exception_type: 'REGULAR_HOLIDAY', description: 'Another year' });
    assert.equal((await snapshots()).length, 0);
    await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    const sms = send({ status: 'SUCCESS' });
    await dispatchSyncLogs(env.ds, { urls: { AUDIT: 'http://sms.test/calendar' }, serviceKey: 'k', enabledConsumers: ['FMS'], fetchImpl: async (u, i) => { sms.delivered.push(i); return new Response('{}'); } });
    assert.equal(sms.delivered.length, 0);
    assert.equal((await snapshots()).find((s) => s.status === 'PENDING') !== undefined, true);
  });

  it('an older database whose status check lacks SUPERSEDED is upgraded on the next sync', async () => {
    const { afterSync } = await import('../src/lib/after-sync.js');
    await env.ds.query('ALTER TABLE sync_log DROP CONSTRAINT sync_log_status_ck');
    await env.ds.query("ALTER TABLE sync_log ADD CONSTRAINT sync_log_status_ck CHECK (status IN ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED'))");
    await afterSync(env.ds);
    await save({ exception_date: '2026-09-21', exception_type: 'REGULAR_HOLIDAY', description: 'A' });
    await save({ exception_date: '2026-09-22', exception_type: 'REGULAR_HOLIDAY', description: 'B' });
    assert.deepEqual((await snapshots()).map((s) => s.status), ['SUPERSEDED', 'PENDING']);
  });
});
