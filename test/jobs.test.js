// Cron jobs (Vercel Cron): the outbox job and vercel.json.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { POST as postException } from '../src/app/api/exceptions/route.js';
import { GET as outboxRoute } from '../src/app/api/jobs/outbox/route.js';
import { runOutboxDispatch } from '../src/jobs/outbox-dispatch.js';
import { req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(() => env?.teardown());

const call = (auth) => outboxRoute(new Request('http://x.test/api/jobs/outbox', { headers: auth ? { authorization: auth } : {} }));

describe('outbox cron job', () => {
  it('sends the audit events a change left in the outbox, once, with the service key', async () => {
    const response = await postException(
      req('POST', '/exceptions', { token: tokens.superAdmin, body: { exception_date: '2026-12-30', exception_type: 'REGULAR_HOLIDAY', description: 'Rizal Day' } }),
    );
    assert.equal(response.status, 201);
    const sent = [];
    process.env.LOGS_SERVICE_URL = 'http://logs.test/api';
    process.env.SERVICE_KEY = 'job-key';
    const fetchImpl = async (url, init) => {
      sent.push({ url, key: init.headers['x-service-key'], body: JSON.parse(init.body) });
      return new Response('{}', { status: 201 });
    };
    const first = await runOutboxDispatch({ fetchImpl });
    assert.equal(first.skipped, false);
    assert.ok(first.sent >= 1);
    assert.ok(sent.every((s) => s.url === 'http://logs.test/api/audit-events' && s.key === 'job-key'));
    assert.ok(sent.some((s) => s.body.action && s.body.entity_type));
    assert.deepEqual(await runOutboxDispatch({ fetchImpl }), { skipped: false, sent: 0, failed: 0 }, 'nothing is sent twice');
  });

  it('is skipped (and says why) when Logs is not configured', async () => {
    delete process.env.LOGS_SERVICE_URL;
    assert.equal((await runOutboxDispatch()).skipped, true);
  });

  it('the route runs it only with the cron secret', async () => {
    delete process.env.CRON_SECRET;
    assert.equal((await call('Bearer x')).status, 401);
    process.env.CRON_SECRET = 'cron-secret';
    try {
      assert.equal((await call()).status, 401);
      assert.equal((await call('Bearer wrong')).status, 401);
      const ok = await call('Bearer cron-secret');
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).job, 'outbox');
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it('both jobs are scheduled in vercel.json', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.deepEqual(vercel.crons.map((c) => c.path).sort(), ['/api/jobs/calendar-sync', '/api/jobs/outbox']);
  });
});
