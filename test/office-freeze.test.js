// EB15: the office list sent to FMS is frozen; the database refuses to change or delete a frozen office ID.
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { freezeOfficeList } from '../src/lib/catalogue/office-freeze.js';
import { updateCatalogueSettings } from '../src/lib/catalogue/settings.js';
import { runReadiness, readinessFailed } from '../src/lib/readiness.js';
import { setupTestEnv } from './calendar-helpers.js';

let env;
const admin = { id: '11111111-1111-4111-8111-111111111111', role: 'super_admin' };
before(async () => { env = await setupTestEnv(); });
after(async () => env?.teardown());
beforeEach(async () => {
  await env.ds.query('DELETE FROM audit_outbox');
  await env.ds.query('DELETE FROM calendar_exceptions');
  await env.ds.query('ALTER TABLE office_list_freeze DISABLE TRIGGER office_list_freeze_append_only');
  await env.ds.query('ALTER TABLE offices DISABLE TRIGGER offices_frozen_guard');
  await env.ds.query('DELETE FROM office_list_freeze');
  await env.ds.query('DELETE FROM offices');
  await env.ds.query('ALTER TABLE offices ENABLE TRIGGER offices_frozen_guard');
  await env.ds.query('ALTER TABLE office_list_freeze ENABLE TRIGGER office_list_freeze_append_only');
});
const addOffice = (code, active = true) => env.ds.query(`INSERT INTO offices (office_id, office_code, office_name, is_active) VALUES (gen_random_uuid(), $1, $1, $2) RETURNING office_id`, [code, active]).then((r) => r[0].office_id);
const setup = () => updateCatalogueSettings(env.ds, admin, { institution_code: 'PUP', applies_to_enabled: true });
const refused = async (sql, params = []) => { try { await env.ds.query(sql, params); return false; } catch { return true; } };

describe('EB15 office list freeze', () => {
  it('refuses before PUP setup, for a non-Super Admin, and while a CAMP- office is active', async () => {
    await addOffice('CAMP-A');
    await assert.rejects(freezeOfficeList(env.ds, admin), { code: 'INSTITUTION_NOT_CONFIGURED' });
    await setup();
    await assert.rejects(freezeOfficeList(env.ds, { id: admin.id, role: 'office_head' }), { status: 403 });
    await assert.rejects(freezeOfficeList(env.ds, admin), { code: 'OFFICE_LIST_NOT_READY' });
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM office_list_freeze'))[0].n, 0);
  });

  it('freezes the active offices, is repeatable, and adds only new offices on a later run', async () => {
    await setup();
    await addOffice('PUP-A');
    await addOffice('PUP-OLD', false);
    const first = await freezeOfficeList(env.ds, admin);
    assert.equal(first.added.length, 1);
    assert.equal((await freezeOfficeList(env.ds, admin)).added.length, 0);
    await addOffice('PUP-B');
    const third = await freezeOfficeList(env.ds, admin);
    assert.deepEqual(third.added.map((o) => o.office_code), ['PUP-B']);
    assert.equal(third.total, 2);
  });

  it('the database refuses to change or delete a frozen office ID, but still allows a rename and deactivation', async () => {
    await setup();
    const id = await addOffice('PUP-A');
    const free = await addOffice('PUP-FREE');
    await freezeOfficeList(env.ds, admin);
    assert.equal(await refused('UPDATE offices SET office_id = gen_random_uuid() WHERE office_id = $1', [id]), true);
    assert.equal(await refused('DELETE FROM offices WHERE office_id = $1', [id]), true);
    assert.equal(await refused("UPDATE offices SET office_name = 'Renamed', is_active = false WHERE office_id = $1", [id]), false);
    // a not-yet-frozen office is not affected
    await addOffice('PUP-NEW');
    const fresh = (await env.ds.query("SELECT office_id FROM offices WHERE office_code = 'PUP-NEW'"))[0].office_id;
    assert.equal(await refused('DELETE FROM offices WHERE office_id = $1', [fresh]), false);
    assert.ok(free);
  });

  it('the freeze list itself is append-only', async () => {
    await setup();
    await addOffice('PUP-A');
    await freezeOfficeList(env.ds, admin);
    assert.equal(await refused('DELETE FROM office_list_freeze'), true);
    assert.equal(await refused("UPDATE office_list_freeze SET office_code = 'X'"), true);
  });

  it('the readiness report shows the freeze and its probes pass', async () => {
    await setup();
    let checks = await runReadiness(env.ds);
    assert.match(checks.find((c) => c.id === 'offices.frozen_count').detail, /not frozen yet/);
    await addOffice('PUP-A');
    await freezeOfficeList(env.ds, admin);
    checks = await runReadiness(env.ds);
    const by = (id) => checks.find((c) => c.id === id);
    assert.equal(by('offices.frozen_exist').status, 'PASS');
    assert.equal(by('constraints.frozen_guard').status, 'PASS');
    assert.equal(by('probe.frozen_id_change').status, 'PASS');
    assert.equal(by('probe.frozen_delete').status, 'PASS');
    assert.equal(readinessFailed(checks), false, JSON.stringify(checks.filter((c) => c.status === 'FAIL')));
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM offices'))[0].n, 1);
  });

  it('the freeze is audited', async () => {
    await setup();
    await addOffice('PUP-A');
    await freezeOfficeList(env.ds, admin);
    const rows = await env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = 'OFFICE_LIST_FROZEN'`);
    assert.equal(rows.length, 1);
  });
});
