import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { before, after, describe, it } from 'node:test';
import { setupTestEnv, tokens, req, ctx } from './calendar-helpers.js';
import { updateCatalogueSettings } from '../src/lib/catalogue/settings.js';
import { createOffice, updateOffice } from '../src/lib/catalogue/offices.js';
import { createService } from '../src/lib/catalogue/services.js';
import { runSeed } from '../src/lib/catalogue/seed.js';
import { POST } from '../src/app/api/services/route.js';
import { PUT } from '../src/app/api/services/[id]/route.js';
import { GET as preview } from '../src/app/api/services/next-code/route.js';

let env, office, other;
const actor = { id: randomUUID(), role: 'super_admin' };
before(async () => {
  env = await setupTestEnv();
  await updateCatalogueSettings(env.ds, actor, { institution_code: 'PUP' });
  office = await createOffice(env.ds, actor, { office_abbr: 'OSAS', office_name: 'Student Affairs' });
  other = await createOffice(env.ds, actor, { office_abbr: 'REG', office_name: 'Registrar' });
});
after(async () => { await env?.teardown(); });
const body = (over = {}) => ({ office_id: office.office_id, service_abbr: 'TOR', service_name: randomUUID(), classification: 'SIMPLE', service_scope: 'EXTERNAL', transaction_types: ['G2C'], standard: { duration_days: 0, duration_hours: 0, duration_minutes: 7, effective_from: '2026-01-01', charter_reference: 'Charter p.1' }, ...over });
const call = async (handler, method, path, value, token = tokens.superAdmin, context) => {
  const response = await handler(req(method, path, { body: value, token }), context);
  return { status: response.status, body: await response.json() };
};
describe('TT8 generated service codes', () => {
  it('previews without inserting or reserving and returns the saved code authoritatively', async () => {
    const p = await call(preview, 'GET', `/services/next-code?officeId=${office.office_id}&abbr=TOR`);
    assert.equal(p.body.service_code, 'PUP-OSAS-TOR-001');
    assert.equal(p.body.reserved, false);
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM services'))[0].n, 0);
    const saved = await call(POST, 'POST', '/services', body());
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.service.service_code, p.body.service_code);
  });
  it('serializes overlapping creates and restarts numbering for another office', async () => {
    const results = await Promise.all(Array.from({ length: 16 }, () => call(POST, 'POST', '/services', body())));
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results));
    const codes = results.map((r) => r.body.service.service_code);
    assert.equal(new Set(codes).size, 16);
    assert.ok(codes.includes('PUP-OSAS-TOR-017'));
    const second = await call(POST, 'POST', '/services', body({ office_id: other.office_id }));
    assert.equal(second.body.service.service_code, 'PUP-REG-TOR-001');
  });
  it('refuses ordinary explicit codes, mixed input and invalid abbreviations', async () => {
    for (const invalid of [{ service_code: 'PUP-OSAS-TOR-020' }, { service_abbr: '' }, { service_abbr: 'T' }, { service_abbr: 'toolong' }, { service_abbr: 'tor' }, { service_abbr: 'T-OR' }]) {
      assert.equal((await call(POST, 'POST', '/services', body(invalid))).status, 400);
    }
    assert.equal((await call(preview, 'GET', '/services/next-code?officeId=bad&abbr=TOR')).status, 400);
    assert.equal((await call(preview, 'GET', `/services/next-code?officeId=${randomUUID()}&abbr=TOR`)).status, 404);
  });
  it('restricts both creation and preview to Super Admin', async () => {
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await call(POST, 'POST', '/services', body(), token)).status, 403);
      assert.equal((await call(preview, 'GET', `/services/next-code?officeId=${office.office_id}&abbr=TOR`, undefined, token)).status, 403);
    }
  });
  it('preserves the original code on rename/transfer and rejects API and SQL rewrites', async () => {
    const saved = await createService(env.ds, actor, body({ service_abbr: 'MV' }));
    const moved = await call(PUT, 'PUT', `/services/${saved.service_id}`, { ...body(), service_abbr: undefined, office_id: other.office_id, service_name: 'Moved service' }, tokens.superAdmin, ctx(saved.service_id));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.service.service_code, saved.service_code);
    const rewritten = await call(PUT, 'PUT', `/services/${saved.service_id}`, { ...body(), service_abbr: undefined, service_code: 'PUP-REG-MV-100' }, tokens.superAdmin, ctx(saved.service_id));
    assert.equal(rewritten.status, 409);
    await assert.rejects(env.ds.query("UPDATE services SET service_code = 'CHANGED' WHERE service_id = $1", [saved.service_id]), (err) => err.code === '23514');
    await assert.rejects(updateOffice(env.ds, actor, other.office_id, { office_abbr: 'NEW', office_name: 'Registrar' }), (err) => err.code === 'OFFICE_CODE_CHANGE_NEEDS_DECISION');
  });
  it('retains seed codes and allocates beyond imported numbers', async () => {
    const seed = body({ service_abbr: undefined, service_code: 'PUP-OSAS-SEE-097', office_code: office.office_code });
    delete seed.service_abbr;
    const result = await runSeed(env.ds, { services: [seed] }, { actor });
    assert.equal(result.counts.services_created, 1, JSON.stringify(result));
    const next = await createService(env.ds, actor, body({ service_abbr: 'SEE' }));
    assert.equal(next.service_code, 'PUP-OSAS-SEE-098');
  });
  it('rolls back sequence allocation with a failed outer transaction and handles exhaustion', async () => {
    await assert.rejects(env.ds.transaction(async (manager) => {
      const scope = { transaction: (work) => work(manager) };
      await createService(scope, actor, body({ service_abbr: 'RB' }));
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await createService(env.ds, actor, body({ service_abbr: 'RB' }))).service_code, 'PUP-OSAS-RB-001');
    await env.ds.query('INSERT INTO service_code_sequences VALUES ($1, $2, 999)', [office.office_id, 'XX']);
    assert.equal((await call(POST, 'POST', '/services', body({ service_abbr: 'XX' }))).status, 409);
  });
});
