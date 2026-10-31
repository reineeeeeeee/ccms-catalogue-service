// EB6: GET /declarations (the snapshot pull route for FMS).
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { GET as declarationsRoute } from '../src/app/api/declarations/route.js';
import { DELETE as deleteRoute } from '../src/app/api/exceptions/[id]/route.js';
import { POST as postRoute } from '../src/app/api/exceptions/route.js';
import { PUT as putSchedule } from '../src/app/api/schedule/route.js';

import { CHARTER_DAYS, SERVICE_KEY, ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;

before(async () => {
  env = await setupTestEnv();
  assert.equal((await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }))).status, 200);
  await env.ds.query(`INSERT INTO catalogue_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  await env.ds.query(`UPDATE catalogue_settings SET applies_to_enabled = true`);
  
});
after(async () => env?.teardown());
beforeEach(async () => {
  await env.ds.query('DELETE FROM sync_log');
  await env.ds.query('DELETE FROM calendar_exceptions');
});

const add = async (body) => {
  const response = await postRoute(req('POST', '/exceptions', { token: tokens.superAdmin, body }));
  return { response, body: await response.json() };
};
const remove = (id) => deleteRoute(req('DELETE', `/exceptions/${id}`, { token: tokens.superAdmin }), ctx(id));
const holiday = (date, extra = {}) => ({ exception_date: date, exception_type: 'REGULAR_HOLIDAY', description: 'Holiday', ...extra });
const pull = async (query, { key = SERVICE_KEY, token } = {}) => {
  const qs = new URLSearchParams(query).toString();
  const response = await declarationsRoute(req('GET', `/declarations?${qs}`, { key, token }));
  return { response, body: await response.json() };
};

describe('EB6: GET /declarations', () => {
  const range = { from: '2026-08-17', to: '2026-12-12' };

  it('returns entries and tombstones in the range, without a messageId', async () => {
    await add(holiday('2026-10-07'));
    const id = (await add(holiday('2026-10-08'))).body.exception.exception_id;
    await remove(id);
    await add(holiday('2027-01-01'));
    const { response, body } = await pull(range);
    assert.equal(response.status, 200);
    assert.equal(body.schemaVersion, 'cal-1.0');
    assert.deepEqual(body.items.map((i) => [i.date, i.changeKind]), [['2026-10-07', 'UPSERT'], ['2026-10-08', 'REMOVE']]);
    assert.ok(body.items.every((i) => !('messageId' in i)));
    assert.equal(body.nextCursor, null);
  });

  it('paging returns each entry exactly once', async () => {
    for (let d = 1; d <= 7; d += 1) await add(holiday(`2026-10-${String(d).padStart(2, '0')}`));
    const seen = [];
    let cursor;
    for (let i = 0; i < 10; i += 1) {
      const { body } = await pull({ ...range, limit: '3', ...(cursor ? { cursor } : {}) });
      seen.push(...body.items.map((x) => x.date));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, ['01', '02', '03', '04', '05', '06', '07'].map((d) => `2026-10-${d}`));
  });

  it('expands a recurring entry to its dates inside the range', async () => {
    await add(holiday('2026-12-25', { is_recurring: true }));
    const { body } = await pull({ from: '2026-12-01', to: '2027-12-31' });
    assert.deepEqual(body.items.map((i) => i.date), ['2026-12-25', '2027-12-25']);
  });

  it('refuses a missing or wrong key and a user token', async () => {
    assert.equal((await pull(range, { key: null })).response.status, 401);
    assert.equal((await pull(range, { key: 'wrong' })).response.status, 401);
    assert.equal((await pull(range, { key: null, token: tokens.superAdmin })).response.status, 401);
  });

  it('refuses a bad range, limit or cursor', async () => {
    assert.equal((await pull({ from: '2026-12-12', to: '2026-08-17' })).response.status, 400);
    assert.equal((await pull({ ...range, limit: '0' })).response.status, 400);
    assert.equal((await pull({ ...range, cursor: '!!' })).response.status, 400);
  });
});
