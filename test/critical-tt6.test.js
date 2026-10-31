import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { before, after, describe, it } from 'node:test';
import { setupTestEnv, tokens, req, ctx } from './calendar-helpers.js';
import { GET, PUT } from '../src/app/api/catalogue-settings/route.js';
import { POST as addOffice } from '../src/app/api/offices/route.js';
import { PUT as editOffice } from '../src/app/api/offices/[id]/route.js';
import { migrateSprint4Core } from '../src/lib/migrations/sprint4-critical.js';

let env;
before(async () => { env = await setupTestEnv(); });
after(async () => { await env?.teardown(); });
const call = async (handler, method, path, body, token = tokens.superAdmin, context) => {
  const res = await handler(req(method, path, { body, token }), context);
  return { status: res.status, body: await res.json() };
};
describe('TT6 institution setup and authoritative office codes', () => {
  it('starts unconfigured and refuses office creation until setup', async () => {
    assert.deepEqual((await call(GET, 'GET', '/catalogue-settings')).body.settings, { institution_code: null, applies_to_enabled: false });
    assert.equal((await call(addOffice, 'POST', '/offices', { office_abbr: 'REG', office_name: 'Registrar' })).status, 409);
  });
  it('refuses unauthorized setup and persists a rejection audit event', async () => {
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await call(PUT, 'PUT', '/catalogue-settings', { institution_code: 'PUP' }, token)).status, 403);
    }
    const [row] = await env.ds.query("SELECT count(*)::int AS n FROM audit_outbox WHERE payload->>'action' = 'CATALOGUE_SETTINGS_CHANGE_REJECTED'");
    assert.equal(row.n, 2); // Executive writes are rejected by the shared read-only guard before the handler.
  });
  it('validates institution boundaries and accepts a single authorized initialization', async () => {
    for (const code of ['', 'P', 'pup', 'P-UP', 'A'.repeat(11), null]) {
      const result = await call(PUT, 'PUT', '/catalogue-settings', { institution_code: code });
      assert.equal(result.status, 400);
      assert.ok(result.body.error.details.institution_code);
    }
    const results = await Promise.all([1, 2].map(() => call(PUT, 'PUT', '/catalogue-settings', { institution_code: 'PUP' })));
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM catalogue_settings'))[0].n, 1);
  });
  it('rejects later code changes at API and database boundaries', async () => {
    assert.equal((await call(PUT, 'PUT', '/catalogue-settings', { institution_code: 'OTHER' })).status, 409);
    await assert.rejects(env.ds.query("UPDATE catalogue_settings SET institution_code = 'OTHER'"), (e) => e.code === '23514');
    await assert.rejects(env.ds.query('DELETE FROM catalogue_settings'), (e) => e.code === '23514');
  });
  it('generates normalized office codes, protects IDs and detects case-insensitive conflicts', async () => {
    const first = await call(addOffice, 'POST', '/offices', { office_abbr: ' reg ', office_name: 'Registrar' });
    assert.equal(first.status, 201);
    assert.equal(first.body.office.office_code, 'PUP-REG');
    const office = first.body.office;
    assert.equal((await call(addOffice, 'POST', '/offices', { office_abbr: 'rEg', office_name: 'Other Registrar' })).status, 409);
    const saved = await call(editOffice, 'PUT', `/offices/${office.office_id}`, { office_abbr: 'REG', office_name: 'Campus Registrar' }, tokens.superAdmin, ctx(office.office_id));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.office.office_id, office.office_id);
  });
  it('enforces total length, malformed abbreviations and server-generated code input', async () => {
    assert.equal((await call(addOffice, 'POST', '/offices', { office_abbr: 'A'.repeat(16), office_name: 'Maximum length office' })).status, 201);
    for (const body of [{ office_abbr: 'A'.repeat(17) }, { office_abbr: 'A-B' }, { office_abbr: '' }, { office_abbr: 'REG', office_code: 'EVIL-REG' }]) {
      assert.equal((await call(addOffice, 'POST', '/offices', { office_name: randomUUID(), ...body })).status, 400);
    }
  });
  it('preserves records on repeated migrations and repeat setup', async () => {
    const beforeRows = await env.ds.query('SELECT office_id, office_code, office_name FROM offices ORDER BY office_id');
    await migrateSprint4Core(env.ds);
    await migrateSprint4Core(env.ds);
    assert.deepEqual(await env.ds.query('SELECT office_id, office_code, office_name FROM offices ORDER BY office_id'), beforeRows);
    assert.equal((await call(PUT, 'PUT', '/catalogue-settings', { institution_code: 'PUP' })).status, 200);
  });
});
