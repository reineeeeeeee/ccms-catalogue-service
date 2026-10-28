import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setupTestEnv, req, ctx, tokens, CHARTER_DAYS } from './calendar-helpers.js';
import { POST, GET } from '../src/app/api/exceptions/route.js';
import { PUT, DELETE } from '../src/app/api/exceptions/[id]/route.js';
import { updateCatalogueSettings } from '../src/lib/catalogue/settings.js';
import { listEffectiveHolidays } from '../src/lib/calendar/exceptions.js';
import { createCalendar, computeWorkingMinutes, computeDeadline } from '../src/lib/calendar/engine/working-time.js';
import { syncSettings } from '../src/jobs/calendar-sync.js';
import { dispatchSyncLogs } from '../src/lib/calendar/sync-dispatch.js';
import { migrateSprint4Core } from '../src/lib/migrations/sprint4-critical.js';

let env;
const actor = { id: randomUUID(), role: 'super_admin' };
before(async () => { env = await setupTestEnv(); });
after(async () => { await env?.teardown(); });
const entry = (over = {}) => ({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'Class/work announcement', ...over });
async function call(handler, method, path, body, token = tokens.superAdmin, context) {
  const res = await handler(req(method, path, { body, token }), context);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
describe('TT7 class/work calendar contract', () => {
  it('preserves legacy behavior and rejects explicit modes while disabled', async () => {
    const saved = await call(POST, 'POST', '/exceptions', entry());
    assert.equal(saved.status, 201);
    assert.equal(saved.body.exception.applies_to, 'BOTH');
    assert.equal(saved.body.exception.class_mode, 'SUSPENDED');
    for (const over of [{ applies_to: 'WORK' }, { applies_to: 'CLASSES' }, { class_mode: 'SUSPENDED' }]) assert.equal((await call(POST, 'POST', '/exceptions', entry(over))).status, 400);
    await call(DELETE, 'DELETE', `/exceptions/${saved.body.exception.exception_id}`, undefined, tokens.superAdmin, ctx(saved.body.exception.exception_id));
  });
  it('explicitly enables PUP and validates every enum/combination', async () => {
    await updateCatalogueSettings(env.ds, actor, { institution_code: 'PUP', applies_to_enabled: true });
    for (const over of [{ applies_to: null }, { applies_to: 'OTHER' }, { applies_to: 'WORK', class_mode: 'ONLINE' }, { applies_to: 'CLASSES', class_mode: null }, { applies_to: 'BOTH', class_mode: 'OTHER' }]) assert.equal((await call(POST, 'POST', '/exceptions', entry(over))).status, 400);
    await assert.rejects(env.ds.query("INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, applies_to, class_mode) VALUES ($1, '2035-01-01', 'SUSPENSION', 'WORK', 'ONLINE')", [randomUUID()]), (err) => err.code === '23514');
  });
  it('creates/updates/lists fields, filters them and audits before/after', async () => {
    const saved = await call(POST, 'POST', '/exceptions', entry({ applies_to: 'CLASSES', class_mode: 'ONLINE' }));
    const id = saved.body.exception.exception_id;
    const updated = await call(PUT, 'PUT', `/exceptions/${id}`, entry({ applies_to: 'BOTH', class_mode: 'ONLINE' }), tokens.superAdmin, ctx(id));
    assert.equal(updated.status, 200);
    const rows = (await call(GET, 'GET', '/exceptions?applies_to=BOTH')).body.items;
    assert.ok(rows.some((r) => r.exception_id === id && r.class_mode === 'ONLINE'));
    assert.equal((await listEffectiveHolidays(env.ds, { from: '2026-10-01', to: '2026-10-31' }))[0].class_mode, 'ONLINE');
    const [audit] = await env.ds.query("SELECT payload FROM audit_outbox WHERE payload->>'action'='CALENDAR_EXCEPTION_UPDATED' AND payload->>'entity_id'=$1", [id]);
    assert.equal(audit.payload.before_value.applies_to, 'CLASSES');
    assert.equal(audit.payload.after_value.applies_to, 'BOTH');
    assert.equal((await call(GET, 'GET', '/exceptions?applies_to=bad')).status, 400);
    await assert.rejects(updateCatalogueSettings(env.ds, actor, { applies_to_enabled: false }), (e) => e.code === 'CALENDAR_SETTING_IN_USE');
  });
  it('retains role boundaries for create/update', async () => {
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) assert.equal((await call(POST, 'POST', '/exceptions', entry({ exception_date: '2027-01-01', applies_to: 'WORK' }), token)).status, 403);
  });
  it('sends additive fields to FMS and SMS through the existing retry dispatcher', async () => {
    const deliveries = [];
    const settings = syncSettings({ SMS_URL: 'https://sms.test/calendar', FMS_URL: 'https://fms.test/calendar', SERVICE_KEY: 'test-only' });
    await dispatchSyncLogs(env.ds, { ...settings, fetchImpl: async (url, init) => { deliveries.push({ url, payload: JSON.parse(init.body) }); return new Response('{}'); } });
    for (const url of ['https://sms.test/calendar', 'https://fms.test/calendar']) {
      const updated = deliveries.find((d) => d.url === url && d.payload.event_type === 'CALENDAR_EXCEPTION_UPDATED');
      assert.ok(updated);
      assert.equal(updated.payload.data.exception.applies_to, 'BOTH');
      assert.equal(updated.payload.data.exception.class_mode, 'ONLINE');
    }
  });
  it('migration leaves entry identities and values intact when repeated', async () => {
    const rows = await env.ds.query('SELECT * FROM calendar_exceptions ORDER BY exception_id');
    await migrateSprint4Core(env.ds); await migrateSprint4Core(env.ds);
    assert.deepEqual(await env.ds.query('SELECT * FROM calendar_exceptions ORDER BY exception_id'), rows);
  });
});

describe('TT7 office-clock effects including ONLINE classes', () => {
  it('counts CLASSES/ONLINE as working and WORK/BOTH as closed in all engine functions', () => {
    const start = Date.parse('2026-10-06T18:00:00+08:00');
    const end = Date.parse('2026-10-08T09:00:00+08:00');
    for (const applies of ['CLASSES', 'WORK', 'BOTH']) {
      const cal = createCalendar({ schedule: CHARTER_DAYS, exceptions: [{ exception_date: '2026-10-07', applies_to: applies, class_mode: applies === 'WORK' ? null : 'ONLINE' }] });
      assert.equal(computeWorkingMinutes(cal, start, end), applies === 'CLASSES' ? 780 : 120);
      assert.ok(Number.isFinite(computeDeadline(cal, { startMs: start, workingDays: 1 })));
    }
  });
});
