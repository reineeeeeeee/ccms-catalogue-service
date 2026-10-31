// EB3-EB5 and C42: calendar message cal-1.0 (envelope, revisions, tombstones, part-day end, effect switch, one-office rule).
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DELETE as deleteRoute, PUT as putRoute } from '../src/app/api/exceptions/[id]/route.js';
import { POST as postRoute } from '../src/app/api/exceptions/route.js';
import { PUT as putSchedule } from '../src/app/api/schedule/route.js';
import { CHARTER_DAYS, OFFICE_A, ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  assert.equal((await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }))).status, 200);
  await env.ds.query(`INSERT INTO catalogue_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  await env.ds.query(`UPDATE catalogue_settings SET applies_to_enabled = true`);
});
after(async () => {
  delete process.env.CAL_EFFECT_ENABLED;
  await env?.teardown();
});
beforeEach(async () => {
  delete process.env.CAL_EFFECT_ENABLED;
  await env.ds.query('DELETE FROM sync_log');
  await env.ds.query('DELETE FROM calendar_exceptions');
});

const add = async (body) => {
  const response = await postRoute(req('POST', '/exceptions', { token: tokens.superAdmin, body }));
  return { response, body: await response.json() };
};
const edit = async (id, body) => {
  const response = await putRoute(req('PUT', `/exceptions/${id}`, { token: tokens.superAdmin, body }), ctx(id));
  return { response, body: await response.json().catch(() => ({})) };
};
const remove = (id) => deleteRoute(req('DELETE', `/exceptions/${id}`, { token: tokens.superAdmin }), ctx(id));
const holiday = (date, extra = {}) => ({ exception_date: date, exception_type: 'REGULAR_HOLIDAY', description: 'Holiday', ...extra });
const queued = async (consumer = 'FMS') =>
  (await env.ds.query(`SELECT sync_id, payload FROM sync_log WHERE consumer_system = $1 ORDER BY created_at, sync_id`, [consumer])).map((r) => ({ syncId: r.sync_id, ...r.payload }));

describe('EB3: cal-1.0 envelope', () => {
  it('every message carries messageId, schemaVersion, entityId, entityRevision, changeKind and an explicit appliesTo', async () => {
    const { body } = await add(holiday('2026-10-07'));
    const [msg] = await queued();
    assert.equal(msg.messageId, msg.syncId);
    assert.equal(msg.schemaVersion, 'cal-1.0');
    assert.equal(msg.entityId, body.exception.exception_id);
    assert.equal(msg.entityRevision, 1);
    assert.equal(msg.changeKind, 'UPSERT');
    assert.deepEqual(msg.appliesTo, ['CLASSES', 'WORK']);
    assert.deepEqual(msg.interval, { start: '2026-10-07T00:00:00+08:00', end: '2026-10-07T24:00:00+08:00', allDay: true });
  });

  it('WORK is sent as ["WORK"] and CLASSES as ["CLASSES"]', async () => {
    await add(holiday('2026-10-07', { applies_to: 'WORK' }));
    await add(holiday('2026-10-08', { applies_to: 'CLASSES', class_mode: 'SUSPENDED' }));
    const byDate = Object.fromEntries((await queued()).map((m) => [m.date, m.appliesTo]));
    assert.deepEqual(byDate['2026-10-07'], ['WORK']);
    assert.deepEqual(byDate['2026-10-08'], ['CLASSES']);
  });

  it('each edit raises the revision by one (2, then 3); an edit that changes nothing does not', async () => {
    const id = (await add(holiday('2026-10-07'))).body.exception.exception_id;
    assert.equal((await edit(id, holiday('2026-10-07', { description: 'One' }))).body.exception.revision, 2);
    assert.equal((await edit(id, holiday('2026-10-07', { description: 'Two' }))).body.exception.revision, 3);
    assert.equal((await edit(id, holiday('2026-10-07', { description: 'Two' }))).body.exception.revision, 3);
    const revisions = (await queued()).filter((m) => m.entityId === id).map((m) => m.entityRevision);
    assert.deepEqual(revisions, [1, 2, 3]);
  });

  it('removing keeps the row as a tombstone and sends REMOVE with a higher revision', async () => {
    const id = (await add(holiday('2026-10-07'))).body.exception.exception_id;
    assert.equal((await remove(id)).status, 204);
    const [row] = await env.ds.query('SELECT revision, removed_at FROM calendar_exceptions WHERE exception_id = $1', [id]);
    assert.equal(row.revision, 2);
    assert.ok(row.removed_at);
    const last = (await queued()).pop();
    assert.equal(last.changeKind, 'REMOVE');
    assert.equal(last.entityId, id);
    assert.equal(last.entityRevision, 2);
  });

  it('a removed entry no longer counts for the engine, and its date can be entered again', async () => {
    const id = (await add(holiday('2026-10-07'))).body.exception.exception_id;
    await remove(id);
    const again = await add(holiday('2026-10-07'));
    assert.equal(again.response.status, 201);
    assert.notEqual(again.body.exception.exception_id, id);
    const list = await (await (await import('../src/app/api/exceptions/route.js')).GET(req('GET', '/exceptions', { token: tokens.superAdmin }))).json();
    assert.equal(JSON.stringify(list).includes(id), false);
  });

  it('a retry sends the same stored message, so the messageId never changes', async () => {
    await add(holiday('2026-10-07'));
    const before = await queued();
    await env.ds.query(`UPDATE sync_log SET status = 'FAILED', attempts = 1`);
    const after = await queued();
    assert.deepEqual(after, before);
  });

  it('a recurring entry is sent as one dated entry per date', async () => {
    const id = (await add(holiday('2026-10-07', { is_recurring: true }))).body.exception.exception_id;
    const msgs = (await queued()).filter((m) => m.entityId.startsWith(id));
    assert.deepEqual(msgs.map((m) => m.entityId), [`${id}@2026-10-07`]);
    assert.equal(msgs[0].date, '2026-10-07');
  });
});

describe('EB4: part-day end time', () => {
  it('a 1:00-5:00 PM suspension sends both times and allDay false', async () => {
    await add({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'Power', suspended_from: '13:00', suspended_until: '17:00' });
    const [msg] = await queued();
    assert.deepEqual(msg.interval, { start: '2026-10-07T13:00:00+08:00', end: '2026-10-07T17:00:00+08:00', allDay: false });
  });

  it('a part-day entry without an end is refused under the end-time field', async () => {
    const { response, body } = await add({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'x', suspended_from: '13:00' });
    assert.equal(response.status, 400);
    assert.ok(JSON.stringify(body).includes('suspended_until'));
  });

  it('an end that is not after the start is refused', async () => {
    const { response } = await add({ exception_date: '2026-10-07', exception_type: 'SUSPENSION', description: 'x', suspended_from: '13:00', suspended_until: '12:00' });
    assert.equal(response.status, 400);
  });

  it('the database also refuses an end without a start', async () => {
    await assert.rejects(
      env.ds.query(`INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, description, is_recurring, suspended_until) VALUES (gen_random_uuid(), '2031-01-01', 'SUSPENSION', 'x', false, '17:00')`),
      (err) => err.code === '23514',
    );
  });
});

describe('EB5: effect switch (default off)', () => {
  const online = () => add(holiday('2026-10-07', { applies_to: 'CLASSES', class_mode: 'ONLINE' }));

  it('with the switch off an ONLINE entry is not sent to FMS, a SUSPENDED one is', async () => {
    await online();
    await add(holiday('2026-10-08', { applies_to: 'CLASSES', class_mode: 'SUSPENDED' }));
    const fms = await queued('FMS');
    assert.deepEqual(fms.map((m) => m.date), ['2026-10-08']);
    assert.ok(fms.every((m) => !('effect' in m)));
  });

  it('with the switch on both are sent with their effect', async () => {
    process.env.CAL_EFFECT_ENABLED = 'true';
    await online();
    await add(holiday('2026-10-08', { applies_to: 'CLASSES', class_mode: 'SUSPENDED' }));
    const effects = Object.fromEntries((await queued('FMS')).map((m) => [m.date, m.effect]));
    assert.deepEqual(effects, { '2026-10-07': 'ONLINE', '2026-10-08': 'SUSPENDED' });
  });

  it('a WORK-only entry never carries an effect value', async () => {
    process.env.CAL_EFFECT_ENABLED = 'true';
    await add(holiday('2026-10-07', { applies_to: 'WORK' }));
    assert.equal((await queued('FMS'))[0].effect, null);
  });
});

describe('C42: one-office entries', () => {
  it('an office entry defaults to WORK', async () => {
    const { response, body } = await add(holiday('2026-10-07', { office_id: OFFICE_A }));
    assert.equal(response.status, 201);
    assert.equal(body.exception.applies_to, 'WORK');
  });

  it('an office entry that affects classes is refused under applies_to', async () => {
    for (const applies_to of ['CLASSES', 'BOTH']) {
      const { response, body } = await add(holiday('2026-10-07', { office_id: OFFICE_A, applies_to, class_mode: 'SUSPENDED' }));
      assert.equal(response.status, 400);
      assert.ok(JSON.stringify(body).includes('applies_to'));
    }
  });

  it('the database refuses it too', async () => {
    await assert.rejects(
      env.ds.query(`INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, description, is_recurring, office_id, applies_to, class_mode) VALUES (gen_random_uuid(), '2031-01-01', 'REGULAR_HOLIDAY', 'x', false, $1, 'BOTH', 'SUSPENDED')`, [OFFICE_A]),
      (err) => err.code === '23514',
    );
  });
});
