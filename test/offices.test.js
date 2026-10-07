import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ROLES, setDataSource, setDefaultVerifier } from 'ccms-shared';
import { createTestDatabase, createTestKeys, runBoundarySuite } from 'ccms-shared/testing';
import { POST as postOffice, GET as listRoute } from '../src/app/api/offices/route.js';
import { GET as getRoute, PUT as putRoute } from '../src/app/api/offices/[id]/route.js';
import { PATCH as deactivateRoute } from '../src/app/api/offices/[id]/deactivate/route.js';
import { PATCH as reactivateRoute } from '../src/app/api/offices/[id]/reactivate/route.js';
import { afterSync } from '../src/lib/after-sync.js';
import { entities } from '../src/lib/entities/index.js';

const SERVICE_KEY = 'test-service-key-0123456789';
const OFFICE_A = randomUUID();
const OFFICE_B = randomUUID();

let testDb;
let ds;
let keys;
const tokens = { superAdmin: null, executive: null, officeHeadA: null, officeStaffA: null };

before(async () => {
  process.env.SERVICE_KEY = SERVICE_KEY;
  keys = await createTestKeys();
  setDefaultVerifier(keys.verifier);
  testDb = await createTestDatabase({ entities, afterSync });
  ds = testDb.dataSource;
  setDataSource(ds);
  tokens.superAdmin = await keys.signToken({ role: ROLES.SUPER_ADMIN, full_name: 'Sam Admin' });
  tokens.executive = await keys.signToken({ role: ROLES.EXECUTIVE });
  tokens.officeHeadA = await keys.signToken({ role: ROLES.OFFICE_HEAD, office_id: OFFICE_A });
  tokens.officeStaffA = await keys.signToken({ role: ROLES.OFFICE_STAFF, office_id: OFFICE_A });
});

after(async () => {
  setDataSource(null);
  await testDb?.drop();
});

const req = (method, path, { token, body, headers } = {}) =>
  new Request(`http://localhost/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
const ctx = (id) => ({ params: Promise.resolve({ id }) });

async function addOffice(code, name, token = tokens.superAdmin) {
  const response = await postOffice(req('POST', '/offices', { token, body: { office_code: code, office_name: name } }));
  return { response, body: await response.json() };
}
const outbox = (action) => ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);

describe('office registry (CC006)', () => {
  it('creates the offices table and the case-insensitive unique index automatically', async () => {
    const [t] = await ds.query(`SELECT to_regclass('public.offices') AS t`);
    assert.equal(t.t, 'offices');
    const indexes = await ds.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'offices'`);
    assert.ok(indexes.some((i) => i.indexname === 'offices_code_lower_uq'));
  });

  it('AC1: Super Admin adds an office; it is saved as active and listed', async () => {
    const { response, body } = await addOffice('  CAO ', "  Campus Academic Office (Charter wording)  ");
    assert.equal(response.status, 201);
    assert.equal(body.office.office_code, 'CAO');
    assert.equal(body.office.office_name, 'Campus Academic Office (Charter wording)');
    assert.equal(body.office.is_active, true);
    const list = await (await listRoute(req('GET', '/offices', { token: tokens.superAdmin }))).json();
    assert.ok(list.items.some((o) => o.office_id === body.office.office_id));
  });

  it('AC2: a second office with the same code, in any letter case, is rejected with 409', async () => {
    await addOffice('OSAS', 'Office of Student Affairs and Services');
    for (const code of ['OSAS', 'osas', 'OsAs']) {
      const { response, body } = await addOffice(code, 'Another name');
      assert.equal(response.status, 409);
      assert.equal(body.error.message, 'Office code already exists');
    }
  });

  it('a second office with the same name is rejected even with a different code (any case, extra spaces)', async () => {
    const first = await addOffice('NAMEA', 'Office of Name Rules');
    assert.equal(first.response.status, 201);
    for (const name of ['Office of Name Rules', 'office of name rules', '  OFFICE   OF  name rules ']) {
      const { response, body } = await addOffice(`DIFF${Math.random().toString(36).slice(2, 6)}`, name);
      assert.equal(response.status, 409);
      assert.equal(body.error.code, 'OFFICE_NAME_EXISTS');
      assert.equal(body.error.details.office_name, 'Office name already exists');
      assert.equal(body.error.details.office_code, undefined);
    }
    // a clash on both reports both fields
    const both = await addOffice('nameA', 'office of name rules');
    assert.equal(both.response.status, 409);
    assert.ok(both.body.error.details.office_code && both.body.error.details.office_name);
    // editing an office to another office's name is rejected; keeping its own name is fine
    const other = await addOffice('NAMEB', 'Another Unique Office');
    const id = other.body.office.office_id;
    const clash = await putRoute(req('PUT', `/offices/${id}`, { token: tokens.superAdmin, body: { office_code: 'NAMEB', office_name: 'OFFICE OF NAME RULES' } }), ctx(id));
    assert.equal(clash.status, 409);
    const own = await putRoute(req('PUT', `/offices/${id}`, { token: tokens.superAdmin, body: { office_code: 'NAMEB2', office_name: 'another unique office' } }), ctx(id));
    assert.equal(own.status, 200);
  });

  it('validates required fields and lengths', async () => {
    const { response, body } = await addOffice('   ', '');
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.office_code && body.error.details.office_name);
  });

  it('edits an office and rejects a code that belongs to another office', async () => {
    const { body: created } = await addOffice('REG', 'Registrar');
    const id = created.office.office_id;
    const ok = await putRoute(req('PUT', `/offices/${id}`, { token: tokens.superAdmin, body: { office_code: 'REGR', office_name: 'Office of the Registrar' } }), ctx(id));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).office.office_code, 'REGR');
    const clash = await putRoute(req('PUT', `/offices/${id}`, { token: tokens.superAdmin, body: { office_code: 'osas', office_name: 'x' } }), ctx(id));
    assert.equal(clash.status, 409);
    const missing = await putRoute(req('PUT', `/offices/${randomUUID()}`, { token: tokens.superAdmin, body: { office_code: 'Z', office_name: 'Z' } }), ctx(randomUUID()));
    assert.equal(missing.status, 404);
  });

  it('AC3/AC4: a deactivated office leaves the dropdown list but stays visible to Super Admin and to the Identity check', async () => {
    const { body: created } = await addOffice('OLD', 'Old Office');
    const id = created.office.office_id;
    const off = await deactivateRoute(req('PATCH', `/offices/${id}/deactivate`, { token: tokens.superAdmin }), ctx(id));
    assert.equal((await off.json()).office.is_active, false);

    const asStaff = await (await listRoute(req('GET', '/offices', { token: tokens.officeStaffA }))).json();
    assert.ok(!asStaff.items.some((o) => o.office_id === id), 'inactive office must not be offered to normal users');
    const asAdmin = await (await listRoute(req('GET', '/offices', { token: tokens.superAdmin }))).json();
    assert.ok(asAdmin.items.some((o) => o.office_id === id && o.is_active === false));

    // Identity's account check: sees the office is inactive, so it can refuse to assign it.
    const service = await getRoute(req('GET', `/offices/${id}`, { headers: { 'x-service-key': SERVICE_KEY } }), ctx(id));
    assert.equal(service.status, 200);
    assert.equal((await service.json()).office.is_active, false);
    const hidden = await getRoute(req('GET', `/offices/${id}`, { token: tokens.officeStaffA }), ctx(id));
    assert.equal(hidden.status, 404);

    const on = await reactivateRoute(req('PATCH', `/offices/${id}/reactivate`, { token: tokens.superAdmin }), ctx(id));
    assert.equal((await on.json()).office.is_active, true);
  });

  it('GET /offices/:id needs the service key or a user token', async () => {
    const { body } = await addOffice('LIB', 'Library');
    const id = body.office.office_id;
    assert.equal((await getRoute(req('GET', `/offices/${id}`), ctx(id))).status, 401);
    assert.equal((await getRoute(req('GET', `/offices/${id}`, { headers: { 'x-service-key': 'wrong' } }), ctx(id))).status, 401);
    assert.equal((await getRoute(req('GET', `/offices/${id}`, { headers: { 'x-service-key': SERVICE_KEY } }), ctx(id))).status, 200);
    assert.equal((await getRoute(req('GET', `/offices/${id}`, { token: tokens.executive }), ctx(id))).status, 200);
    assert.equal((await getRoute(req('GET', '/offices/not-a-uuid', { token: tokens.superAdmin }), ctx('not-a-uuid'))).status, 404);
  });

  it('AC5: Office Head, Office Staff and Executive get 403 on any office change', async () => {
    const { body } = await addOffice('SEC', 'Security');
    const id = body.office.office_id;
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await postOffice(req('POST', '/offices', { token, body: { office_code: 'NEW', office_name: 'New' } }))).status, 403);
      assert.equal((await putRoute(req('PUT', `/offices/${id}`, { token, body: { office_code: 'SEC', office_name: 'Sec' } }), ctx(id))).status, 403);
      assert.equal((await deactivateRoute(req('PATCH', `/offices/${id}/deactivate`, { token }), ctx(id))).status, 403);
      assert.equal((await reactivateRoute(req('PATCH', `/offices/${id}/reactivate`, { token }), ctx(id))).status, 403);
    }
    const anonymous = await postOffice(req('POST', '/offices', { body: { office_code: 'A', office_name: 'A' } }));
    assert.equal(anonymous.status, 401);
  });

  it('AC6: each change writes an audit entry with before and after values', async () => {
    const { body } = await addOffice('AUD', 'Audit Office');
    const id = body.office.office_id;
    await putRoute(req('PUT', `/offices/${id}`, { token: tokens.superAdmin, body: { office_code: 'AUD', office_name: 'Audit Office Renamed' } }), ctx(id));
    await deactivateRoute(req('PATCH', `/offices/${id}/deactivate`, { token: tokens.superAdmin }), ctx(id));
    await reactivateRoute(req('PATCH', `/offices/${id}/reactivate`, { token: tokens.superAdmin }), ctx(id));

    const mine = async (action) => (await outbox(action)).map((r) => r.payload).filter((p) => p.entity_id === id);
    const [created] = await mine('OFFICE_CREATED');
    assert.equal(created.before_value, null);
    assert.equal(created.after_value.office_name, 'Audit Office');
    assert.equal(created.actor_role, ROLES.SUPER_ADMIN);
    assert.equal(created.office_id, id);
    const [updated] = await mine('OFFICE_UPDATED');
    assert.equal(updated.before_value.office_name, 'Audit Office');
    assert.equal(updated.after_value.office_name, 'Audit Office Renamed');
    const [deactivated] = await mine('OFFICE_DEACTIVATED');
    assert.equal(deactivated.before_value.is_active, true);
    assert.equal(deactivated.after_value.is_active, false);
    const [reactivated] = await mine('OFFICE_REACTIVATED');
    assert.equal(reactivated.after_value.is_active, true);
  });

  it('does not audit a request that changes nothing', async () => {
    const { body } = await addOffice('NOP', 'No-op Office');
    const id = body.office.office_id;
    await deactivateRoute(req('PATCH', `/offices/${id}/deactivate`, { token: tokens.superAdmin }), ctx(id));
    await deactivateRoute(req('PATCH', `/offices/${id}/deactivate`, { token: tokens.superAdmin }), ctx(id));
    await putRoute(req('PUT', `/offices/${id}`, { token: tokens.superAdmin, body: { office_code: 'NOP', office_name: 'No-op Office' } }), ctx(id));
    const rows = (await outbox('OFFICE_DEACTIVATED')).filter((r) => r.payload.entity_id === id);
    assert.equal(rows.length, 1);
    assert.equal((await outbox('OFFICE_UPDATED')).filter((r) => r.payload.entity_id === id).length, 0);
  });

  it('rolls back the office when its audit event cannot be recorded (same transaction)', async () => {
    await ds.query('ALTER TABLE audit_outbox RENAME TO audit_outbox_x');
    try {
      const response = await postOffice(req('POST', '/offices', { token: tokens.superAdmin, body: { office_code: 'ROLL', office_name: 'Rollback' } }));
      assert.equal(response.status, 500);
    } finally {
      await ds.query('ALTER TABLE audit_outbox_x RENAME TO audit_outbox');
    }
    const rows = await ds.query(`SELECT 1 FROM offices WHERE office_code = 'ROLL'`);
    assert.equal(rows.length, 0);
  });
});

const officeBId = randomUUID();
runBoundarySuite({
  name: 'catalogue offices',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'POST /offices',
      write: true,
      superAdminOnly: true,
      invoke: (token) => postOffice(req('POST', '/offices', { token, body: { office_code: `B${Math.floor(Math.random() * 1e6)}`, office_name: 'Boundary' } })),
    },
    {
      name: 'PUT /offices/:id',
      write: true,
      superAdminOnly: true,
      invoke: (token) => putRoute(req('PUT', `/offices/${officeBId}`, { token, body: { office_code: 'X', office_name: 'X' } }), ctx(officeBId)),
    },
    {
      name: 'PATCH /offices/:id/deactivate',
      write: true,
      superAdminOnly: true,
      invoke: (token) => deactivateRoute(req('PATCH', `/offices/${officeBId}/deactivate`, { token }), ctx(officeBId)),
    },
    {
      name: 'GET /offices (read-only reference list)',
      write: false,
      officeScoped: false,
      invoke: (token) => listRoute(req('GET', '/offices', { token })),
    },
  ],
});

// Keep the linter happy about the helper used only by the suite above.
void OFFICE_B;
