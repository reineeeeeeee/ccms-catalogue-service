// CC018 (calendar sharing) and TT2 (mock FMS and Audit), end to end with the mocks from mocks/.
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { POST as ackRoute } from '../src/app/api/sync/ack/route.js';
import { GET as statusRoute } from '../src/app/api/sync/status/route.js';
import { POST as postException } from '../src/app/api/exceptions/route.js';
import { PUT as putSchedule } from '../src/app/api/schedule/route.js';
import { POST as postTerm } from '../src/app/api/terms/route.js';
import { GET as syncJobRoute } from '../src/app/api/jobs/calendar-sync/route.js';
import { runCalendarSync, syncSettings } from '../src/jobs/calendar-sync.js';
import { dispatchSyncLogs } from '../src/lib/calendar/sync-dispatch.js';
import { createMockServer } from '../mocks/mock-server.js';
import { CHARTER_DAYS, SERVICE_KEY, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
let fms;
let audit;
let fmsUrl;
let auditUrl;

// The mocks reach CCMS through the real route handler instead of a network port.
const ccmsFetch = (url, init) => {
  assert.ok(String(url).endsWith('/api/sync/ack'));
  return ackRoute(new Request(url, init));
};

before(async () => {
  env = await setupTestEnv();
  fms = createMockServer({ name: 'FMS', serviceKey: SERVICE_KEY, ccmsUrl: 'http://ccms.test', fetchImpl: ccmsFetch });
  audit = createMockServer({ name: 'AUDIT', serviceKey: SERVICE_KEY, ccmsUrl: 'http://ccms.test', fetchImpl: ccmsFetch });
  fmsUrl = `http://127.0.0.1:${await fms.listen(0)}`;
  auditUrl = `http://127.0.0.1:${await audit.listen(0)}`;
});
after(async () => {
  await fms?.close();
  await audit?.close();
  await env?.teardown();
});
beforeEach(async () => {
  await env.ds.query('DELETE FROM sync_log');
  await env.ds.query('DELETE FROM calendar_exceptions');
  await env.ds.query('DELETE FROM term_dates');
  fms.state.fail = false;
  audit.state.fail = false;
  fms.state.received = [];
  audit.state.received = [];
});

const settings = (extra = {}) => ({ urls: { FMS: `${fmsUrl}/calendar`, AUDIT: `${auditUrl}/calendar` }, serviceKey: SERVICE_KEY, retryIntervalMs: 0, maxAttempts: 5, ...extra });
const dispatch = (extra) => dispatchSyncLogs(env.ds, settings(extra));
const rows = () => env.ds.query('SELECT sync_id, consumer_system, event_type, status, attempts, last_error, last_synced_at, next_attempt_at FROM sync_log ORDER BY consumer_system');
const rowOf = async (consumer) => (await rows()).find((r) => r.consumer_system === consumer);
const holiday = (date = '2026-12-25') => ({ exception_date: date, exception_type: 'REGULAR_HOLIDAY', description: 'Christmas Day' });
const save = async (body = holiday()) => postException(req('POST', '/exceptions', { token: tokens.superAdmin, body }));
const ack = (syncId, opts = { key: SERVICE_KEY }) => ackRoute(req('POST', '/sync/ack', { ...opts, body: { sync_id: syncId } }));
const status = async (token = tokens.superAdmin) => (await statusRoute(req('GET', '/sync/status', { token }))).json();
const mockAck = async (syncId) => (await fetch(`${auditUrl}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sync_id: syncId }) })).json();

describe('CC018 pushing to FMS and Audit', () => {
  it('AC1: saving a holiday creates one row for FMS and one for Audit, and both end up SENT', async () => {
    assert.equal((await save()).status, 201);
    const pending = await rows();
    assert.deepEqual(pending.map((r) => [r.consumer_system, r.event_type, r.status]), [
      ['AUDIT', 'CALENDAR_EXCEPTION_ADDED', 'PENDING'],
      ['FMS', 'CALENDAR_EXCEPTION_ADDED', 'PENDING'],
    ]);
    assert.deepEqual(await dispatch(), { sent: 2, failed: 0 });
    const sent = await rows();
    assert.deepEqual(sent.map((r) => [r.consumer_system, r.status, r.attempts]), [['AUDIT', 'SENT', 1], ['FMS', 'SENT', 1]]);
    assert.ok(sent.every((r) => r.last_synced_at && r.last_error === null));
    // Sending again sends nothing: a SENT row is done.
    assert.deepEqual(await dispatch(), { sent: 0, failed: 0 });
    assert.equal(fms.state.received.length, 1);
    assert.equal(audit.state.received.length, 1);
  });

  it('the push carries the sync_id, the event and the saved holiday, with the shared key', async () => {
    const { exception } = await (await save()).json();
    await dispatch();
    const [push] = fms.state.received;
    assert.equal(push.path, '/calendar');
    assert.equal(push.body.event_type, 'CALENDAR_EXCEPTION_ADDED');
    assert.equal(push.body.consumer_system, 'FMS');
    assert.equal(push.body.entity_type, 'calendar_exception');
    assert.equal(push.body.entity_id, exception.exception_id);
    assert.equal(push.body.data.exception.exception_date, '2026-12-25');
    assert.equal(push.body.data.exception.exception_type, 'REGULAR_HOLIDAY');
    assert.ok(push.body.occurred_at);
    assert.equal(push.body.sync_id, (await rowOf('FMS')).sync_id);
    assert.equal(audit.state.received[0].body.sync_id, (await rowOf('AUDIT')).sync_id);
    assert.notEqual(push.body.sync_id, audit.state.received[0].body.sync_id);
    assert.ok(push.correlation_id);
    // A wrong key is refused by the mock, so a SENT row proves the key was sent.
    const refused = await fetch(`${fmsUrl}/calendar`, { method: 'POST', headers: { 'x-service-key': 'wrong' }, body: '{}' });
    assert.equal(refused.status, 401);
  });

  it('every kind of change queues its rows: schedule (FMS + Audit), term (Audit only)', async () => {
    assert.equal((await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }))).status, 200);
    const termResponse = await postTerm(req('POST', '/terms', { token: tokens.superAdmin, body: { term_name: 'T1', start_date: '2026-08-17', end_date: '2026-12-18' } }));
    assert.equal(termResponse.status, 201);
    const all = await rows();
    const summary = all.map((r) => `${r.event_type}:${r.consumer_system}`).sort();
    assert.deepEqual(summary, [
      'TERM_ADDED:AUDIT',
      'WORKING_HOURS_UPDATED:AUDIT',
      'WORKING_HOURS_UPDATED:FMS',
    ]);
    await dispatch();
    assert.equal(audit.state.received.length, 2);
    assert.equal(fms.state.received.length, 1);
    assert.equal(audit.state.received.find((p) => p.body.event_type === 'TERM_ADDED').body.data.term.term_name, 'T1');
    assert.equal(fms.state.received[0].body.data.items.length, 7);
  });

  it('AC2: a mock Audit acknowledgment sets ACKNOWLEDGED with last_synced_at, and the status shows when Audit last synced', async () => {
    await save();
    await dispatch();
    const before = await status();
    assert.equal(before.audit_last_synced, null, 'SENT is not yet acknowledged');
    const auditRow = await rowOf('AUDIT');
    const result = await mockAck(auditRow.sync_id);
    assert.equal(result.ccms_status, 200);
    assert.equal(result.ccms_response.status, 'ACKNOWLEDGED');
    const after = await rowOf('AUDIT');
    assert.equal(after.status, 'ACKNOWLEDGED');
    assert.ok(after.last_synced_at);
    const now = await status();
    assert.equal(now.audit_last_synced, new Date(after.last_synced_at).toISOString());
    const recent = now.recent.find((r) => r.sync_id === auditRow.sync_id);
    assert.deepEqual(recent, {
      sync_id: auditRow.sync_id,
      consumer_system: 'AUDIT',
      event_type: 'CALENDAR_EXCEPTION_ADDED',
      status: 'ACKNOWLEDGED',
      last_synced_at: now.audit_last_synced,
      attempts: 1,
    });
    // Acknowledging twice keeps the first time.
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal((await ack(auditRow.sync_id)).status, 200);
    assert.equal((await status()).audit_last_synced, now.audit_last_synced);
  });

  it('an acknowledgment that arrives before the row is marked SENT is not overwritten', async () => {
    await save();
    const auditRow = await rowOf('AUDIT');
    assert.equal((await ack(auditRow.sync_id)).status, 200);
    await dispatch();
    assert.equal((await rowOf('AUDIT')).status, 'ACKNOWLEDGED');
    assert.equal((await rowOf('FMS')).status, 'SENT');
  });

  it('FMS has no acknowledgment link: acknowledging an FMS row is refused and changes nothing', async () => {
    await save();
    await dispatch();
    const fmsRow = await rowOf('FMS');
    const response = await ack(fmsRow.sync_id);
    assert.equal(response.status, 409);
    assert.equal((await rowOf('FMS')).status, 'SENT');
  });

  it('AC3: with the mock FMS down the holiday still saves, the FMS row is FAILED and is retried until SENT', async () => {
    fms.state.fail = true;
    const response = await save();
    assert.equal(response.status, 201, 'the save is not blocked');
    const { exception } = await response.json();
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM calendar_exceptions WHERE exception_id = $1', [exception.exception_id]))[0].n, 1, 'and is not undone');

    assert.deepEqual(await dispatch(), { sent: 1, failed: 1 });
    const failed = await rowOf('FMS');
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, /503/);
    assert.equal((await rowOf('AUDIT')).status, 'SENT', 'Audit is not held back by FMS');
    const down = await status();
    assert.equal(down.fms_last_push.status, 'FAILED');
    assert.ok(down.fms_last_push.at);

    // Still down: retried again, still FAILED.
    assert.deepEqual(await dispatch(), { sent: 0, failed: 1 });
    assert.equal((await rowOf('FMS')).attempts, 2);

    // FMS is back: the next retry sends it.
    fms.state.fail = false;
    assert.deepEqual(await dispatch(), { sent: 1, failed: 0 });
    const sent = await rowOf('FMS');
    assert.equal(sent.status, 'SENT');
    assert.equal(sent.attempts, 3);
    assert.equal(sent.last_error, null);
    assert.equal(fms.state.received.length, 1, 'the holiday reached FMS exactly once');
    assert.equal((await status()).fms_last_push.status, 'SENT');
  });

  it('retries wait for the retry interval and stop after the maximum number of attempts', async () => {
    fms.state.fail = true;
    await save();
    let clock = new Date(Date.now() + 5000); // after the row's first due time
    const now = () => clock;
    const options = { retryIntervalMs: 60_000, maxAttempts: 3, now };
    await dispatch(options);
    assert.equal((await rowOf('FMS')).attempts, 1);
    // Not due yet.
    assert.deepEqual(await dispatch(options), { sent: 0, failed: 0 });
    clock = new Date(clock.getTime() + 61_000);
    assert.deepEqual(await dispatch(options), { sent: 0, failed: 1 });
    clock = new Date(clock.getTime() + 61_000);
    assert.deepEqual(await dispatch(options), { sent: 0, failed: 1 });
    assert.equal((await rowOf('FMS')).attempts, 3);
    // Out of attempts: it stays FAILED (visible in red) and is no longer tried.
    clock = new Date(clock.getTime() + 61_000);
    fms.state.fail = false;
    assert.deepEqual(await dispatch(options), { sent: 0, failed: 0 });
    assert.equal((await rowOf('FMS')).status, 'FAILED');
  });

  it('a system that cannot be reached, or has no URL, marks the row FAILED without touching the save', async () => {
    await save();
    await dispatch({ urls: { FMS: 'http://127.0.0.1:1/calendar', AUDIT: null } });
    const [a, f] = await rows();
    assert.equal(a.status, 'FAILED');
    assert.match(a.last_error, /AUDIT_URL is not configured/);
    assert.equal(f.status, 'FAILED');
    assert.ok(f.last_error);
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM calendar_exceptions'))[0].n, 1);
    // Once the URLs are right they go out.
    assert.deepEqual(await dispatch(), { sent: 2, failed: 0 });
  });

  it('the cron job sends what is due on each run and keeps retrying a down FMS until it is back', async () => {
    Object.assign(process.env, {
      FMS_URL: `${fmsUrl}/calendar`,
      AUDIT_URL: `${auditUrl}/calendar`,
      SERVICE_KEY,
      SYNC_RETRY_INTERVAL_SECONDS: '0.01',
      SYNC_MAX_ATTEMPTS: '50',
    });
    try {
      assert.equal(syncSettings().retryIntervalMs, 10);
      fms.state.fail = true;
      assert.equal((await save()).status, 201);
      // Nothing is sent by the save itself: there is no background process. The cron run does it.
      assert.equal((await rowOf('AUDIT')).status, 'PENDING');
      assert.deepEqual(await runCalendarSync(), { skipped: false, sent: 1, failed: 1 });
      assert.equal((await rowOf('AUDIT')).status, 'SENT');
      assert.equal((await rowOf('FMS')).status, 'FAILED');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(await runCalendarSync(), { skipped: false, sent: 0, failed: 1 });
      assert.ok((await rowOf('FMS')).attempts >= 2);
      fms.state.fail = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(await runCalendarSync(), { skipped: false, sent: 1, failed: 0 });
      assert.equal((await rowOf('FMS')).status, 'SENT');
      assert.equal(fms.state.received.length, 1);
    } finally {
      for (const name of ['FMS_URL', 'AUDIT_URL', 'SYNC_RETRY_INTERVAL_SECONDS', 'SYNC_MAX_ATTEMPTS']) delete process.env[name];
    }
  });

  it('two overlapping cron runs never push the same row twice', async () => {
    await save();
    await save({ ...holiday('2026-12-26'), description: 'Day after Christmas' });
    await Promise.all([dispatch({ batchSize: 2 }), dispatch({ batchSize: 2 })]);
    assert.equal(fms.state.received.length, 2, 'each holiday reaches FMS exactly once');
    assert.equal(audit.state.received.length, 2);
    assert.ok((await rows()).every((r) => r.status === 'SENT' && r.attempts === 1));
  });

  it('the cron route needs the cron secret; without SERVICE_KEY the job is skipped and says so', async () => {
    const call = (auth) => syncJobRoute(new Request('http://x.test/api/jobs/calendar-sync', { headers: auth ? { authorization: auth } : {} }));
    delete process.env.CRON_SECRET;
    assert.equal((await call('Bearer x')).status, 401, 'no CRON_SECRET configured: the job never runs');
    process.env.CRON_SECRET = 'cron-secret';
    try {
      assert.equal((await call()).status, 401);
      assert.equal((await call('Bearer nope')).status, 401);
      const saved = process.env.SERVICE_KEY;
      delete process.env.SERVICE_KEY;
      const skipped = await call('Bearer cron-secret');
      process.env.SERVICE_KEY = saved;
      assert.equal(skipped.status, 200);
      assert.deepEqual(await skipped.json(), { job: 'calendar-sync', skipped: true, reason: 'SERVICE_KEY is required', sent: 0, failed: 0 });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it('AC4: an acknowledgment without the shared key returns 401 and changes nothing', async () => {
    await save();
    await dispatch();
    const auditRow = await rowOf('AUDIT');
    for (const opts of [{}, { key: 'wrong-key' }, { token: tokens.superAdmin }]) {
      const response = await ack(auditRow.sync_id, opts);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'INVALID_SERVICE_KEY');
    }
    const row = await rowOf('AUDIT');
    assert.equal(row.status, 'SENT');
    assert.equal(new Date(row.last_synced_at).getTime(), new Date(auditRow.last_synced_at).getTime());
  });

  it('AC5: an acknowledgment for an unknown sync ID returns 404 and changes nothing', async () => {
    await save();
    await dispatch();
    const before = await rows();
    for (const id of ['3f0d3c1e-7a51-4b53-9a31-0a6f2d6b9e11', 'not-a-uuid']) {
      const response = await ack(id);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'SYNC_NOT_FOUND');
    }
    assert.deepEqual(await rows(), before);
    const missing = await ackRoute(req('POST', '/sync/ack', { key: SERVICE_KEY, body: {} }));
    assert.equal(missing.status, 400);
  });

  it('GET /sync/status: empty, then with rows; Super Admin only', async () => {
    const empty = await status();
    assert.deepEqual(empty, { audit_last_synced: null, fms_last_push: null, recent: [] });
    await save();
    const pending = await status(tokens.superAdmin);
    assert.equal(pending.recent.length, 2);
    assert.deepEqual(pending.fms_last_push.status, 'PENDING');
    assert.deepEqual(Object.keys(pending.recent[0]).sort(), ['attempts', 'consumer_system', 'event_type', 'last_synced_at', 'status', 'sync_id']);
    for (const [name, token] of Object.entries(tokens)) assert.equal((await statusRoute(req('GET', '/sync/status', { token }))).status, name === 'superAdmin' ? 200 : 403, name);
    assert.equal((await statusRoute(req('GET', '/sync/status'))).status, 401);
    assert.equal((await statusRoute(req('GET', '/sync/status', { key: SERVICE_KEY }))).status, 401);
  });

  it('a rejected save queues no push', async () => {
    await save();
    const count = (await rows()).length;
    assert.equal((await save()).status, 409);
    assert.equal((await rows()).length, count);
  });
});

describe('TT2 the mock FMS and Audit services', () => {
  it('record pushes, report them on GET /received and can be cleared', async () => {
    await save();
    await dispatch();
    const report = await (await fetch(`${fmsUrl}/received`)).json();
    assert.equal(report.system, 'FMS');
    assert.equal(report.count, 1);
    assert.equal(report.fail, false);
    assert.equal(report.items[0].body.event_type, 'CALENDAR_EXCEPTION_ADDED');
    await fetch(`${fmsUrl}/received`, { method: 'DELETE' });
    assert.equal((await (await fetch(`${fmsUrl}/received`)).json()).count, 0);
  });

  it('are switched to fail and back with POST /mode, and report what they turned away', async () => {
    const set = (fail) => fetch(`${fmsUrl}/mode`, { method: 'POST', body: JSON.stringify({ fail }) });
    assert.deepEqual(await (await set(true)).json(), { system: 'FMS', fail: true });
    assert.equal((await fetch(`${fmsUrl}/calendar`, { method: 'POST', headers: { 'x-service-key': SERVICE_KEY }, body: '{}' })).status, 503);
    assert.equal((await (await fetch(`${fmsUrl}/received`)).json()).rejected, 1);
    await set(false);
    assert.equal((await fetch(`${fmsUrl}/calendar`, { method: 'POST', headers: { 'x-service-key': SERVICE_KEY }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${fmsUrl}/mode`, { method: 'POST', body: '{"fail":"yes"}' })).status, 400);
    assert.equal((await fetch(`${fmsUrl}/mode`, { method: 'POST', body: 'nope' })).status, 400);
  });

  it('only the Audit mock sends acknowledgments, and it needs a sync_id', async () => {
    assert.equal((await fetch(`${fmsUrl}/ack`, { method: 'POST', body: '{"sync_id":"x"}' })).status, 404);
    assert.equal((await fetch(`${auditUrl}/ack`, { method: 'POST', body: '{}' })).status, 400);
    const unknown = await (await fetch(`${auditUrl}/ack`, { method: 'POST', body: '{"sync_id":"3f0d3c1e-7a51-4b53-9a31-0a6f2d6b9e11"}' })).json();
    assert.equal(unknown.ccms_status, 404);
  });

  it('the Audit mock reports an unreachable CCMS instead of crashing', async () => {
    const lonely = createMockServer({ name: 'AUDIT', serviceKey: SERVICE_KEY, ccmsUrl: 'http://127.0.0.1:1' });
    const port = await lonely.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/ack`, { method: 'POST', body: '{"sync_id":"x"}' });
    assert.equal(response.status, 502);
    await lonely.close();
  });
});
