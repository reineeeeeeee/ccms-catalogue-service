import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ROLES, setDataSource, setDefaultVerifier } from 'ccms-shared';
import { createTestDatabase, createTestKeys, runBoundarySuite } from 'ccms-shared/testing';
import { POST as postOffice } from '../src/app/api/offices/route.js';
import { PATCH as deactivateOffice } from '../src/app/api/offices/[id]/deactivate/route.js';
import { GET as listRoute, POST as postService } from '../src/app/api/services/route.js';
import { GET as getService, PUT as putService } from '../src/app/api/services/[id]/route.js';
import { PATCH as deactivateService } from '../src/app/api/services/[id]/deactivate/route.js';
import { PATCH as reactivateService } from '../src/app/api/services/[id]/reactivate/route.js';
import { GET as listStandards, POST as postStandard } from '../src/app/api/services/[id]/standards/route.js';
import { DELETE as deleteStandard } from '../src/app/api/services/[id]/standards/[standardId]/route.js';
import { GET as asOfRoute } from '../src/app/api/services/[id]/standard/route.js';
import { POST as postDocument } from '../src/app/api/services/[id]/documents/route.js';
import { DELETE as deleteDocument, PUT as putDocument } from '../src/app/api/services/[id]/documents/[documentId]/route.js';
import { GET as publicList } from '../src/app/api/public/services/route.js';
import { GET as publicDetail } from '../src/app/api/public/services/[id]/route.js';
import { addDays, manilaToday } from '../src/lib/catalogue/catalogue-rules.js';
import { afterSync } from '../src/lib/after-sync.js';
import { entities } from '../src/lib/entities/index.js';
import { publicLimiter } from '../src/lib/catalogue/public-catalogue.js';
import { runSeed } from '../src/lib/catalogue/seed.js';

const SERVICE_KEY = 'test-service-key-0123456789';
let testDb;
let ds;
let keys;
const tokens = { superAdmin: null, executive: null, officeHeadA: null, officeStaffA: null };
let registrar; // { office_id, office_code }
let library;

before(async () => {
  process.env.SERVICE_KEY = SERVICE_KEY;
  keys = await createTestKeys();
  setDefaultVerifier(keys.verifier);
  testDb = await createTestDatabase({ entities, afterSync });
  ds = testDb.dataSource;
  setDataSource(ds);
  tokens.superAdmin = await keys.signToken({ role: ROLES.SUPER_ADMIN, full_name: 'Sam Admin' });
  tokens.executive = await keys.signToken({ role: ROLES.EXECUTIVE });
  registrar = await addOffice('REG', 'Registrar');
  library = await addOffice('LIB', 'Library');
  // "Office A" is the Registrar (a real office with services); "office B" is the Library.
  tokens.officeHeadA = await keys.signToken({ role: ROLES.OFFICE_HEAD, office_id: registrar.office_id });
  tokens.officeStaffA = await keys.signToken({ role: ROLES.OFFICE_STAFF, office_id: registrar.office_id });
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
const ctx = (id, extra = {}) => ({ params: Promise.resolve({ id, ...extra }) });
const SA = () => tokens.superAdmin;

async function addOffice(code, name) {
  const response = await postOffice(req('POST', '/offices', { token: SA(), body: { office_code: code, office_name: name } }));
  assert.equal(response.status, 201);
  return (await response.json()).office;
}

const today = () => manilaToday();
const validStandard = (over = {}) => ({
  duration_days: 0,
  duration_hours: 0,
  duration_minutes: 7,
  effective_from: addDays(today(), -30),
  charter_reference: 'Charter p. 1',
  ...over,
});

let counter = 0;
function serviceBody(office = registrar, over = {}) {
  counter += 1;
  const n = String(counter).padStart(3, '0');
  return {
    office_id: office.office_id,
    service_code: `${office.office_code}-T${n}-${n}`,
    service_name: `Test Service ${n}`,
    classification: 'SIMPLE',
    service_scope: 'EXTERNAL',
    transaction_types: ['G2C'],
    standard: validStandard(),
    ...over,
  };
}

async function createService(over = {}, office = registrar) {
  const response = await postService(req('POST', '/services', { token: SA(), body: serviceBody(office, over) }));
  const body = await response.json();
  return { response, body, service: body.service };
}
async function makeService(over = {}, office = registrar) {
  const { response, service, body } = await createService(over, office);
  assert.equal(response.status, 201, JSON.stringify(body));
  return service;
}

const callJson = async (handler, request, context) => {
  const response = await handler(request, context);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
};

const addStandard = (id, body, token = SA()) => callJson(postStandard, req('POST', `/services/${id}/standards`, { token, body }), ctx(id));
const addDoc = (id, body, token = SA()) => callJson(postDocument, req('POST', `/services/${id}/documents`, { token, body }), ctx(id));
const asOf = (id, date, opts = { token: SA() }) =>
  callJson(asOfRoute, req('GET', `/services/${id}/standard${date ? `?asOf=${date}` : ''}`, opts), ctx(id));
const detail = (id, token = SA()) => callJson(getService, req('GET', `/services/${id}`, { token }), ctx(id));
const list = (query = '', token = SA()) => callJson(listRoute, req('GET', `/services${query}`, { token }));
const audits = async (action, entityId) =>
  (await ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]))
    .map((r) => r.payload)
    .filter((p) => !entityId || p.entity_id === entityId);

function nextMonday() {
  // Days until the next Monday strictly after today, using the Manila calendar date.
  for (let i = 1; i <= 7; i += 1) {
    const date = addDays(today(), i);
    if (new Date(`${date}T12:00:00+08:00`).getUTCDay() === 1) return date;
  }
  throw new Error('unreachable');
}

describe('CC007 add service with first standard', () => {
  it('creates the tables and the uniqueness indexes automatically', async () => {
    const indexes = (await ds.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('services', 'service_standards', 'required_documents')`)).map((i) => i.indexname);
    for (const name of ['services_office_name_uq', 'services_code_lower_uq', 'service_standards_from_uq', 'required_documents_name_uq']) {
      assert.ok(indexes.includes(name), name);
    }
  });

  it('AC1: Super Admin adds a service; it is active with version 1 in force from the chosen date', async () => {
    const from = addDays(today(), -10);
    const { response, service } = await createService({
      service_name: 'Transcript of Records',
      service_code: 'REG-TOR-001',
      fees: '  None  ',
      who_may_avail: '  PUP Students  ',
      service_scope: 'INTERNAL',
      transaction_types: ['G2C', 'G2G'],
      standard: validStandard({ effective_from: from, duration_days: 3, duration_minutes: 0 }),
    });
    assert.equal(response.status, 201);
    assert.equal(service.is_active, true);
    assert.equal(service.measurement_type, 'TIMELINESS');
    assert.equal(service.office_name, 'Registrar');
    assert.equal(service.current_standard.version_no, 1);
    assert.equal(service.current_standard.effective_from, from);
    assert.equal(service.current_standard.effective_to, null);
    assert.equal(service.service_scope, 'INTERNAL');
    assert.deepEqual(service.transaction_types, ['G2C', 'G2G']);
    assert.equal(service.current_standard.duration_days, 3);
    assert.equal(service.current_standard.duration_hours, 0);
    assert.equal(service.current_standard.duration_minutes, 0);
    assert.equal(service.current_standard.charter_reference, 'Charter p. 1');
    assert.equal(service.fees, 'None');
    assert.equal(service.who_may_avail, 'PUP Students');
    const saved = await detail(service.service_id);
    assert.equal(saved.body.service.fees, 'None');
    assert.equal(saved.body.service.who_may_avail, 'PUP Students');
  });

  it('a first standard that starts in the future is saved but not yet the current standard', async () => {
    const { response, service } = await createService({ standard: validStandard({ effective_from: addDays(today(), 5) }) });
    assert.equal(response.status, 201);
    assert.equal(service.current_standard, null);
  });

  it('AC2: the same name under the same office is rejected in any case or spacing', async () => {
    for (const name of ['Transcript of Records', 'TRANSCRIPT OF RECORDS', '  transcript   of   records ']) {
      const { response, body } = await createService({ service_name: name });
      assert.equal(response.status, 409, name);
      assert.equal(body.error.message, 'This office already has a service with this name');
    }
  });

  it('AC3: the same name under a different office is accepted', async () => {
    const { response } = await createService({ service_name: 'Transcript of Records' }, library);
    assert.equal(response.status, 201);
  });

  it('AC4: a duplicate service_code is rejected with "Service code already exists"', async () => {
    for (const code of ['REG-TOR-001', 'reg-tor-001']) {
      const { response, body } = await createService({ service_code: code });
      assert.equal(response.status, 409);
      assert.equal(body.error.message, 'Service code already exists');
    }
    const other = await createService({ service_code: 'LIB-TOR-001', service_name: 'Some other library service' }, library);
    assert.equal(other.response.status, 201);
    const clash = await createService({ service_code: 'LIB-TOR-001' }, library);
    assert.equal(clash.response.status, 409);
  });

  it('AC5: classification, service scope and transaction types are validated', async () => {
    const a = await createService({ classification: 'EASY' });
    assert.equal(a.response.status, 400);
    assert.ok(a.body.error.details.classification);
    const b = await createService({ transaction_types: ['B2B'] });
    assert.equal(b.response.status, 400);
    assert.ok(b.body.error.details.transaction_types);
    const scope = await createService({ service_scope: 'PUBLIC' });
    assert.ok(scope.body.error.details.service_scope);
    const both = await createService({ classification: null, service_scope: undefined, transaction_types: undefined });
    assert.ok(both.body.error.details.classification && both.body.error.details.service_scope && both.body.error.details.transaction_types);
    assert.ok((await createService({ transaction_types: [] })).body.error.details.transaction_types);
    assert.ok((await createService({ transaction_types: ['G2C', 'G2C'] })).body.error.details.transaction_types);
  });

  it('AC6: an inactive or unknown office is rejected with "Office not found or inactive"', async () => {
    const closed = await addOffice('CLS', 'Closed Office');
    await deactivateOffice(req('PATCH', `/offices/${closed.office_id}/deactivate`, { token: SA() }), ctx(closed.office_id));
    const inactive = await createService({}, closed);
    assert.equal(inactive.response.status, 400);
    assert.equal(inactive.body.error.message, 'Office not found or inactive');
    const unknown = await createService({ office_id: randomUUID() });
    assert.equal(unknown.body.error.message, 'Office not found or inactive');
    const notUuid = await createService({ office_id: 'nope' });
    assert.equal(notUuid.body.error.message, 'Office not found or inactive');
  });

  it('validates name, code format, steps and the standard block', async () => {
    const short = await createService({ service_name: 'ab' });
    assert.ok(short.body.error.details.service_name);
    assert.equal((await createService({ service_name: 'x'.repeat(200) })).response.status, 201);
    const tooLong = await createService({ service_name: 'x'.repeat(201) });
    assert.ok(tooLong.body.error.details.service_name);
    for (const bad of ['a<b name', 'say "hi" now', 'tick`s here', 'x>yz']) {
      const r = await createService({ service_name: bad });
      assert.ok(r.body.error.details.service_name, bad);
    }
    const code = await createService({ service_code: 'WRONG-FORMAT' });
    assert.equal(code.response.status, 400);
    assert.ok(code.body.error.details.service_code);
    const noStandard = await createService({ standard: undefined });
    assert.ok(noStandard.body.error.details.standard);
    const badStandard = await createService({ standard: { duration_days: -1, duration_hours: 1.5, duration_minutes: 'nope', effective_from: 'soon', charter_reference: ' ' } });
    for (const field of ['duration_days', 'duration_hours', 'duration_minutes', 'effective_from', 'charter_reference']) {
      assert.ok(badStandard.body.error.details[`standard.${field}`], field);
    }
    const zero = await createService({ standard: validStandard({ duration_minutes: 0 }) });
    assert.ok(zero.body.error.details['standard.duration']);
    const badReferenceFields = await createService({ fees: 50, who_may_avail: false });
    assert.ok(badReferenceFields.body.error.details.fees);
    assert.ok(badReferenceFields.body.error.details.who_may_avail);
    const longReferenceFields = await createService({ fees: 'x'.repeat(501), who_may_avail: 'x'.repeat(501) });
    assert.ok(longReferenceFields.body.error.details.fees);
    assert.ok(longReferenceFields.body.error.details.who_may_avail);
  });

  it('normalises whitespace in the saved name and upper-cases the code', async () => {
    const service = await makeService({ service_name: '  Library   Card  Renewal ', service_code: 'lib-lcr-001' }, library);
    assert.equal(service.service_name, 'Library Card Renewal');
    assert.equal(service.service_code, 'LIB-LCR-001');
  });

  it('AC7: Office Head, Office Staff and Executive get 403; no token gets 401', async () => {
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      const response = await postService(req('POST', '/services', { token, body: serviceBody() }));
      assert.equal(response.status, 403);
    }
    assert.equal((await postService(req('POST', '/services', { body: serviceBody() }))).status, 401);
  });

  it('writes SERVICE_CREATED and STANDARD_VERSION_CREATED audit events with office_id set', async () => {
    const service = await makeService();
    const [created] = await audits('SERVICE_CREATED', service.service_id);
    assert.equal(created.office_id, registrar.office_id);
    assert.equal(created.before_value, null);
    assert.equal(created.after_value.service_name, service.service_name);
    assert.equal(created.actor_role, ROLES.SUPER_ADMIN);
    assert.equal(created.entity_type, 'Service');
    const versions = (await audits('STANDARD_VERSION_CREATED')).filter((p) => p.after_value.service_id === service.service_id);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].office_id, registrar.office_id);
    assert.equal(versions[0].entity_type, 'ServiceStandard');
    assert.equal(versions[0].after_value.version_no, 1);
  });

  it('creates the service and its standard in one transaction (nothing is left if the audit fails)', async () => {
    const body = serviceBody(registrar, { service_name: 'Rollback Me' });
    await ds.query('ALTER TABLE audit_outbox RENAME TO audit_outbox_x');
    try {
      assert.equal((await postService(req('POST', '/services', { token: SA(), body }))).status, 500);
    } finally {
      await ds.query('ALTER TABLE audit_outbox_x RENAME TO audit_outbox');
    }
    assert.equal((await ds.query(`SELECT 1 FROM services WHERE service_name = 'Rollback Me'`)).length, 0);
    assert.equal((await ds.query(`SELECT 1 FROM service_standards ss WHERE NOT EXISTS (SELECT 1 FROM services s WHERE s.service_id = ss.service_id)`)).length, 0);
  });
});

describe('CC008 edit and deactivate a service', () => {
  const edit = (id, body, token = SA()) => callJson(putService, req('PUT', `/services/${id}`, { token, body }), ctx(id));
  const editBody = (s, over = {}) => ({
    office_id: s.office_id,
    service_code: s.service_code,
    service_name: s.service_name,
    classification: s.classification,
    service_scope: s.service_scope,
    transaction_types: s.transaction_types,
    processing_steps: s.processing_steps,
    fees: s.fees,
    who_may_avail: s.who_may_avail,
    ...over,
  });

  it('AC1: edited fields are saved with a before/after audit entry; the standard is untouched', async () => {
    const service = await makeService({ fees: 'None', who_may_avail: 'Students' });
    const { status, body } = await edit(
      service.service_id,
      editBody(service, { classification: 'COMPLEX', service_scope: 'INTERNAL', transaction_types: ['G2B', 'G2G'], fees: 'PHP 50 per page', who_may_avail: 'Students and alumni' }),
    );
    assert.equal(status, 200);
    assert.equal(body.service.classification, 'COMPLEX');
    assert.equal(body.service.service_scope, 'INTERNAL');
    assert.deepEqual(body.service.transaction_types, ['G2B', 'G2G']);
    assert.equal(body.service.fees, 'PHP 50 per page');
    assert.equal(body.service.who_may_avail, 'Students and alumni');
    assert.equal(body.service.current_standard.standard_id, service.current_standard.standard_id);
    const [entry] = await audits('SERVICE_UPDATED', service.service_id);
    assert.equal(entry.before_value.classification, 'SIMPLE');
    assert.equal(entry.after_value.classification, 'COMPLEX');
    assert.equal(entry.before_value.fees, 'None');
    assert.equal(entry.after_value.fees, 'PHP 50 per page');
    assert.equal(entry.before_value.who_may_avail, 'Students');
    assert.equal(entry.after_value.who_may_avail, 'Students and alumni');
    assert.equal(entry.office_id, registrar.office_id);
    assert.equal(entry.entity_type, 'Service');
    assert.equal((await edit(service.service_id, editBody(body.service))).status, 200);
    assert.equal((await audits('SERVICE_UPDATED', service.service_id)).length, 1, 're-submitting the same values is not audited');
  });

  it('can change name, code and office, with the CC007 rules re-checked', async () => {
    const service = await makeService();
    const moved = await edit(service.service_id, editBody(service, { office_id: library.office_id, service_code: 'LIB-MOV-001', service_name: 'Moved  Service' }));
    assert.equal(moved.status, 200);
    assert.equal(moved.body.service.office_name, 'Library');
    assert.equal(moved.body.service.service_name, 'Moved Service');
    const badCode = await edit(service.service_id, editBody(moved.body.service, { service_code: 'REG-MOV-001' }));
    assert.equal(badCode.status, 400, 'the code prefix must match the (new) office');
    const badClass = await edit(service.service_id, editBody(moved.body.service, { classification: 'NOPE' }));
    assert.equal(badClass.status, 400);
    assert.ok(badClass.body.error.details.classification);
    const inactive = await addOffice('ZZZ', 'Zed Office');
    await deactivateOffice(req('PATCH', `/offices/${inactive.office_id}/deactivate`, { token: SA() }), ctx(inactive.office_id));
    const toInactive = await edit(service.service_id, editBody(moved.body.service, { office_id: inactive.office_id, service_code: 'ZZZ-MOV-001' }));
    assert.equal(toInactive.body.error.message, 'Office not found or inactive');
    assert.equal((await edit(randomUUID(), editBody(service))).status, 404);
  });

  it('AC2: renaming to a name that already exists in the same office is rejected', async () => {
    const one = await makeService({ service_name: 'Edit Dup One' });
    const two = await makeService({ service_name: 'Edit Dup Two' });
    const clash = await edit(two.service_id, editBody(two, { service_name: '  EDIT dup   one ' }));
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.message, 'This office already has a service with this name');
    const codeClash = await edit(two.service_id, editBody(two, { service_code: one.service_code }));
    assert.equal(codeClash.status, 409);
    assert.equal(codeClash.body.error.message, 'Service code already exists');
    // Changing only the letter case of its own name is fine.
    assert.equal((await edit(two.service_id, editBody(two, { service_name: 'EDIT DUP TWO' }))).status, 200);
  });

  it('does not audit an edit that changes nothing', async () => {
    const service = await makeService();
    assert.equal((await edit(service.service_id, editBody(service))).status, 200);
    assert.equal((await audits('SERVICE_UPDATED', service.service_id)).length, 0);
  });

  it('AC3: a deactivated service disappears from the public page and the list, and the as-of lookup says "Service inactive"', async () => {
    const service = await makeService({ service_name: 'Soon Inactive Service' });
    const id = service.service_id;
    const before = await callJson(publicDetail, req('GET', `/public/services/${id}`), ctx(id));
    assert.equal(before.status, 200);

    const off = await callJson(deactivateService, req('PATCH', `/services/${id}/deactivate`, { token: SA() }), ctx(id));
    assert.equal(off.status, 200);
    assert.equal(off.body.service.is_active, false);

    await publicLimiter.reset();
    assert.equal((await callJson(publicDetail, req('GET', `/public/services/${id}`), ctx(id))).status, 404);
    const publicSearch = await callJson(publicList, req('GET', '/public/services?search=Soon%20Inactive'));
    assert.equal(publicSearch.body.total, 0);
    const staffList = await list('?search=Soon%20Inactive', tokens.officeStaffA);
    assert.equal(staffList.body.total, 0);
    const lookup = await asOf(id, null);
    assert.equal(lookup.status, 409);
    assert.equal(lookup.body.error.message, 'Service inactive');

    const [entry] = await audits('SERVICE_DEACTIVATED', id);
    assert.equal(entry.before_value.is_active, true);
    assert.equal(entry.after_value.is_active, false);
    assert.equal(entry.office_id, registrar.office_id);
  });

  it('AC4: a reactivated service appears again', async () => {
    const service = await makeService({ service_name: 'Comes Back Service' });
    const id = service.service_id;
    await deactivateService(req('PATCH', `/services/${id}/deactivate`, { token: SA() }), ctx(id));
    const on = await callJson(reactivateService, req('PATCH', `/services/${id}/reactivate`, { token: SA() }), ctx(id));
    assert.equal(on.body.service.is_active, true);
    await publicLimiter.reset();
    assert.equal((await callJson(publicDetail, req('GET', `/public/services/${id}`), ctx(id))).status, 200);
    assert.equal((await list('?search=Comes%20Back', tokens.officeStaffA)).body.total, 1);
    assert.equal((await asOf(id, null)).status, 200);
    assert.equal((await audits('SERVICE_REACTIVATED', id)).length, 1);
    // Repeating the action is a no-op without a second audit entry.
    await reactivateService(req('PATCH', `/services/${id}/reactivate`, { token: SA() }), ctx(id));
    assert.equal((await audits('SERVICE_REACTIVATED', id)).length, 1);
  });

  it('AC5: Office Head, Office Staff and Executive get 403 on edit, deactivate and reactivate', async () => {
    const service = await makeService();
    const id = service.service_id;
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await edit(id, editBody(service), token)).status, 403);
      assert.equal((await deactivateService(req('PATCH', `/services/${id}/deactivate`, { token }), ctx(id))).status, 403);
      assert.equal((await reactivateService(req('PATCH', `/services/${id}/reactivate`, { token }), ctx(id))).status, 403);
    }
    assert.equal((await detail(id)).body.service.is_active, true);
  });
});

describe('CC009 version a standard', () => {
  it('AC1: adding version 2 effective next Monday sets version 1 to end on the Sunday before', async () => {
    const service = await makeService();
    const monday = nextMonday();
    const sunday = addDays(monday, -1);
    const { status, body } = await addStandard(service.service_id, validStandard({ effective_from: monday, duration_hours: 4, duration_minutes: 0, charter_reference: 'Charter rev 2' }));
    assert.equal(status, 201);
    assert.equal(body.standard.version_no, 2);
    assert.equal(body.standard.effective_to, null);
    const history = (await detail(service.service_id)).body.standards;
    const v1 = history.find((s) => s.version_no === 1);
    assert.equal(v1.effective_to, sunday);
    assert.equal(new Date(`${sunday}T12:00:00+08:00`).getUTCDay(), 0);
    const [entry] = (await audits('STANDARD_VERSION_CREATED')).filter((p) => p.entity_id === body.standard.standard_id);
    assert.equal(entry.office_id, registrar.office_id);
  });

  it('AC2: the as-of lookup returns version 1 for today and version 2 for next Monday', async () => {
    const service = await makeService();
    const monday = nextMonday();
    const added = await addStandard(service.service_id, validStandard({ effective_from: monday, duration_hours: 2, duration_minutes: 0 }));
    const now = await asOf(service.service_id, today());
    assert.equal(now.body.standard_id, service.current_standard.standard_id);
    assert.deepEqual([now.body.duration_days, now.body.duration_hours, now.body.duration_minutes], [0, 0, 7]);
    const later = await asOf(service.service_id, monday);
    assert.equal(later.body.standard_id, added.body.standard.standard_id);
    assert.deepEqual([later.body.duration_days, later.body.duration_hours, later.body.duration_minutes], [0, 2, 0]);
    const sunday = await asOf(service.service_id, addDays(monday, -1));
    assert.equal(sunday.body.standard_id, service.current_standard.standard_id);
  });

  it('AC3: an effective_from before today is rejected with "A new standard cannot start in the past"', async () => {
    const service = await makeService();
    const { status, body } = await addStandard(service.service_id, validStandard({ effective_from: addDays(today(), -1) }));
    assert.equal(status, 400);
    assert.equal(body.error.message, 'A new standard cannot start in the past');
    assert.equal((await detail(service.service_id)).body.standards.length, 1);
  });

  it('a version may start today; version 1 then ends yesterday', async () => {
    const service = await makeService();
    const { status } = await addStandard(service.service_id, validStandard({ effective_from: today(), duration_minutes: 9 }));
    assert.equal(status, 201);
    const now = await asOf(service.service_id, today());
    assert.equal(now.body.duration_minutes, 9);
    const v1 = (await detail(service.service_id)).body.standards.find((s) => s.version_no === 1);
    assert.equal(v1.effective_to, addDays(today(), -1));
  });

  it('AC4: a second version with the same effective_from is rejected with 409', async () => {
    const service = await makeService();
    const from = addDays(today(), 14);
    assert.equal((await addStandard(service.service_id, validStandard({ effective_from: from }))).status, 201);
    const again = await addStandard(service.service_id, validStandard({ effective_from: from, duration_minutes: 11 }));
    assert.equal(again.status, 409);
    const alsoConcurrent = await Promise.all([1, 2].map((n) => addStandard(service.service_id, validStandard({ effective_from: addDays(today(), 30), duration_minutes: n }))));
    assert.deepEqual(alsoConcurrent.map((r) => r.status).sort(), [201, 409]);
  });

  it('rejects a version that would start before a newer one; validates the fields', async () => {
    const service = await makeService();
    await addStandard(service.service_id, validStandard({ effective_from: addDays(today(), 20) }));
    const older = await addStandard(service.service_id, validStandard({ effective_from: addDays(today(), 10) }));
    assert.equal(older.status, 409);
    const invalid = await addStandard(service.service_id, { duration_days: -2, duration_hours: -1, duration_minutes: -3, effective_from: '', charter_reference: '' });
    assert.equal(invalid.status, 400);
    for (const field of ['duration_days', 'duration_hours', 'duration_minutes', 'effective_from', 'charter_reference']) assert.ok(invalid.body.error.details[field], field);
    assert.equal((await addStandard(randomUUID(), validStandard({ effective_from: addDays(today(), 3) }))).status, 404);
  });

  it('AC5: history shows every version, newest first, with all duration parts, dates and Charter reference', async () => {
    const service = await makeService();
    await addStandard(service.service_id, validStandard({ effective_from: addDays(today(), 7), duration_hours: 2, duration_minutes: 0, charter_reference: 'Ref two' }));
    await addStandard(service.service_id, validStandard({ effective_from: addDays(today(), 21), duration_days: 1, duration_hours: 1, duration_minutes: 40, charter_reference: 'Ref three' }));
    const history = await callJson(listStandards, req('GET', `/services/${service.service_id}/standards`, { token: tokens.officeStaffA }), ctx(service.service_id));
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.items.map((s) => s.version_no), [3, 2, 1]);
    const [v3, v2, v1] = history.body.items;
    assert.deepEqual([v3.duration_days, v3.duration_hours, v3.duration_minutes, v3.charter_reference, v3.effective_to], [1, 1, 40, 'Ref three', null]);
    assert.equal(v2.effective_to, addDays(v3.effective_from, -1));
    assert.equal(v1.effective_to, addDays(v2.effective_from, -1));
    for (const s of history.body.items) for (const key of ['standard_id', 'service_id', 'version_no', 'duration_days', 'duration_hours', 'duration_minutes', 'effective_from', 'effective_to', 'charter_reference', 'created_at']) assert.ok(key in s, key);
  });

  it('AC6: Office Head, Office Staff and Executive get 403 when adding a version', async () => {
    const service = await makeService();
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await addStandard(service.service_id, validStandard({ effective_from: addDays(today(), 9) }), token)).status, 403);
    }
    assert.equal((await detail(service.service_id)).body.standards.length, 1);
  });

  it('a future version can be deleted (previous version reopened, audited); versions in effect cannot', async () => {
    const service = await makeService();
    const id = service.service_id;
    const v2 = (await addStandard(id, validStandard({ effective_from: addDays(today(), 10) }))).body.standard;
    const v3 = (await addStandard(id, validStandard({ effective_from: addDays(today(), 20) }))).body.standard;
    const del = (standardId, token = SA()) => deleteStandard(req('DELETE', `/services/${id}/standards/${standardId}`, { token }), ctx(id, { standardId }));

    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) assert.equal((await del(v3.standard_id, token)).status, 403);
    const inEffect = await del(service.current_standard.standard_id);
    assert.equal(inEffect.status, 409);
    assert.equal((await del(randomUUID())).status, 404);

    const removed = await del(v3.standard_id);
    assert.equal(removed.status, 204);
    const afterDelete = (await detail(id)).body.standards;
    assert.deepEqual(afterDelete.map((s) => s.version_no), [2, 1]);
    assert.equal(afterDelete[0].effective_to, null);
    const [entry] = await audits('STANDARD_VERSION_DELETED', v3.standard_id);
    assert.equal(entry.before_value.version_no, 3);
    assert.equal(entry.after_value, null);
    assert.equal(entry.office_id, registrar.office_id);

    assert.equal((await del(v2.standard_id)).status, 204);
    const reopened = (await detail(id)).body.standards;
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].effective_to, null);
    // A new version after deletions gets the next free number and works again.
    assert.equal((await addStandard(id, validStandard({ effective_from: addDays(today(), 10) }))).body.standard.version_no, 2);
  });
});

describe('CC010 required-documents checklist', () => {
  it('AC1: a mandatory document shows on the service and on the public page', async () => {
    const service = await makeService({ service_name: 'Checklist Service' });
    const added = await addDoc(service.service_id, { document_name: 'Valid Government-Issued ID', is_mandatory: true });
    assert.equal(added.status, 201);
    assert.equal(added.body.document.document_name, 'Valid Government-Issued ID');
    assert.equal(added.body.document.is_mandatory, true);
    assert.equal(added.body.document.notes, null);
    const onService = (await detail(service.service_id, tokens.officeStaffA)).body.documents;
    assert.deepEqual(onService.map((d) => d.document_name), ['Valid Government-Issued ID']);
    await publicLimiter.reset();
    const onPublic = (await callJson(publicDetail, req('GET', `/public/services/${service.service_id}`), ctx(service.service_id))).body.service.documents;
    assert.deepEqual(onPublic, [{ document_name: 'Valid Government-Issued ID', is_mandatory: true, notes: null }]);
    const [entry] = await audits('REQUIRED_DOCUMENT_ADDED', added.body.document.document_id);
    assert.equal(entry.office_id, registrar.office_id);
    assert.equal(entry.entity_type, 'RequiredDocument');
  });

  it('AC2: edits and removals show immediately, and are audited', async () => {
    const service = await makeService();
    const id = service.service_id;
    const { body } = await addDoc(id, { document_name: 'Photocopy of Receipt', is_mandatory: false });
    const documentId = body.document.document_id;
    const docCtx = ctx(id, { documentId });
    const edited = await callJson(putDocument, req('PUT', `/services/${id}/documents/${documentId}`, { token: SA(), body: { document_name: 'Official Receipt', is_mandatory: true, notes: 'Original only' } }), docCtx);
    assert.equal(edited.status, 200);
    assert.deepEqual([edited.body.document.document_name, edited.body.document.is_mandatory, edited.body.document.notes], ['Official Receipt', true, 'Original only']);
    assert.equal((await detail(id)).body.documents[0].document_name, 'Official Receipt');
    const [update] = await audits('REQUIRED_DOCUMENT_UPDATED', documentId);
    assert.equal(update.before_value.document_name, 'Photocopy of Receipt');
    assert.equal(update.after_value.document_name, 'Official Receipt');

    const removed = await deleteDocument(req('DELETE', `/services/${id}/documents/${documentId}`, { token: SA() }), docCtx);
    assert.equal(removed.status, 204);
    assert.deepEqual((await detail(id)).body.documents, []);
    const [entry] = await audits('REQUIRED_DOCUMENT_REMOVED', documentId);
    assert.equal(entry.before_value.document_name, 'Official Receipt');
    assert.equal(entry.after_value, null);
    const again = await deleteDocument(req('DELETE', `/services/${id}/documents/${documentId}`, { token: SA() }), docCtx);
    assert.equal(again.status, 404);
  });

  it('AC3: a blank document name is rejected', async () => {
    const service = await makeService();
    for (const name of ['', '   ', undefined, null, 5]) {
      const { status, body } = await addDoc(service.service_id, { document_name: name, is_mandatory: true });
      assert.equal(status, 400);
      assert.ok(body.error.details.document_name);
    }
    const bad = await addDoc(service.service_id, { document_name: 'Something', is_mandatory: 'yes' });
    assert.ok(bad.body.error.details.is_mandatory);
    const { body } = await addDoc(service.service_id, { document_name: 'Real' });
    const blankEdit = await callJson(putDocument, req('PUT', `/services/${service.service_id}/documents/${body.document.document_id}`, { token: SA(), body: { document_name: ' ' } }), ctx(service.service_id, { documentId: body.document.document_id }));
    assert.equal(blankEdit.status, 400);
  });

  it('keeps a document name once per service (any case) and 404s for an unknown service', async () => {
    const service = await makeService();
    assert.equal((await addDoc(service.service_id, { document_name: 'Birth Certificate' })).status, 201);
    assert.equal((await addDoc(service.service_id, { document_name: '  birth   CERTIFICATE ' })).status, 409);
    assert.equal((await addDoc(randomUUID(), { document_name: 'Anything' })).status, 404);
  });

  it('accepts Charter document names up to 250 characters and notes up to 1000', async () => {
    const service = await makeService();
    assert.equal((await addDoc(service.service_id, { document_name: 'n'.repeat(250), notes: 'x'.repeat(1000) })).status, 201);
    const longName = await addDoc(service.service_id, { document_name: 'n'.repeat(251) });
    assert.match(longName.body.error.details.document_name, /250/);
    const longNotes = await addDoc(service.service_id, { document_name: 'Another document', notes: 'x'.repeat(1001) });
    assert.match(longNotes.body.error.details.notes, /1000/);
  });

  it('AC4: no file input or upload endpoint exists anywhere', () => {
    const root = new URL('../src', import.meta.url).pathname;
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(root);
    assert.ok(files.length > 10);
    assert.ok(!files.some((f) => /upload|attachment/i.test(f)), 'no upload route or component');
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!/type=["']file["']/.test(text), `${file} has a file input`);
      assert.ok(!/formData\(\)|multipart\/form-data/i.test(text), `${file} accepts multipart uploads`);
    }
  });

  it('AC5: Office Head, Office Staff and Executive get 403 when changing the checklist', async () => {
    const service = await makeService();
    const id = service.service_id;
    const { body } = await addDoc(id, { document_name: 'Protected Doc' });
    const documentId = body.document.document_id;
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await addDoc(id, { document_name: 'Nope' }, token)).status, 403);
      const put = await putDocument(req('PUT', `/services/${id}/documents/${documentId}`, { token, body: { document_name: 'Changed' } }), ctx(id, { documentId }));
      assert.equal(put.status, 403);
      const del = await deleteDocument(req('DELETE', `/services/${id}/documents/${documentId}`, { token }), ctx(id, { documentId }));
      assert.equal(del.status, 403);
    }
    assert.equal((await detail(id)).body.documents.length, 1);
  });
});

describe('CC011 procedure steps (reference only)', () => {
  const steps = '1. Submit the form.\n2. <script>alert("x")</script> Pay at the cashier.';

  it('AC1: entered steps show read-only on the service detail and the public page; empty text becomes null', async () => {
    const service = await makeService({ service_name: 'Steps Service', processing_steps: steps });
    assert.equal(service.processing_steps, steps);
    assert.equal((await detail(service.service_id, tokens.officeStaffA)).body.service.processing_steps, steps);
    await publicLimiter.reset();
    assert.equal((await callJson(publicDetail, req('GET', `/public/services/${service.service_id}`), ctx(service.service_id))).body.service.processing_steps, steps);
    const blank = await makeService({ processing_steps: '   ' });
    assert.equal(blank.processing_steps, null);
    const tooLong = await createService({ processing_steps: 'x'.repeat(10001) });
    assert.ok(tooLong.body.error.details.processing_steps);
    const notText = await createService({ processing_steps: 12 });
    assert.ok(notText.body.error.details.processing_steps);
  });

  it('AC1: steps can be edited through PUT and are kept when an edit omits them', async () => {
    const service = await makeService({ processing_steps: 'Old steps' });
    const id = service.service_id;
    const base = { office_id: service.office_id, service_code: service.service_code, service_name: service.service_name, classification: 'SIMPLE', service_scope: 'EXTERNAL', transaction_types: ['G2C'] };
    const put = (body) => callJson(putService, req('PUT', `/services/${id}`, { token: SA(), body }), ctx(id));
    assert.equal((await put({ ...base, processing_steps: 'New steps' })).body.service.processing_steps, 'New steps');
    assert.equal((await put({ ...base })).body.service.processing_steps, 'New steps');
    assert.equal((await put({ ...base, processing_steps: null })).body.service.processing_steps, null);
  });

  it('AC2: HTML or script is stored and returned as plain text (JSON, never markup), unchanged', async () => {
    const service = await makeService({ processing_steps: '<img src=x onerror=alert(1)> & <b>bold</b>' });
    await publicLimiter.reset();
    const response = await publicDetail(req('GET', `/public/services/${service.service_id}`), ctx(service.service_id));
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).service.processing_steps, '<img src=x onerror=alert(1)> & <b>bold</b>');
  });

  it('AC3: no transaction-side lookup uses the procedure text', async () => {
    const service = await makeService({ processing_steps: 'Reference only text' });
    const lookup = await asOf(service.service_id, today());
    assert.deepEqual(Object.keys(lookup.body).sort(), ['duration_days', 'duration_hours', 'duration_minutes', 'office_id', 'service_code', 'service_name', 'standard_id']);
    assert.ok(!JSON.stringify(lookup.body).includes('Reference only'));
  });
});

describe('CC012 internal catalogue browse', () => {
  let inactive;
  before(async () => {
    await makeService({ service_name: 'Browse Alpha', classification: 'SIMPLE' });
    await makeService({ service_name: 'Browse Beta', classification: 'COMPLEX', service_scope: 'INTERNAL' }, library);
    await makeService({ service_name: 'Browse Gamma', classification: 'HIGHLY_TECHNICAL', standard: validStandard({ duration_hours: 1, duration_minutes: 0 }) });
    inactive = await makeService({ service_name: 'Browse Hidden' });
    await deactivateService(req('PATCH', `/services/${inactive.service_id}/deactivate`, { token: SA() }), ctx(inactive.service_id));
  });

  it('AC1: signed-in users (every role) see active services with office, classification and current standard', async () => {
    for (const token of [tokens.superAdmin, tokens.executive, tokens.officeHeadA, tokens.officeStaffA]) {
      const { status, body } = await list('?search=Browse', token);
      assert.equal(status, 200);
      const names = body.items.map((s) => s.service_name);
      const seesAll = token === tokens.superAdmin || token === tokens.executive;
      assert.ok(names.includes('Browse Alpha') && names.includes('Browse Gamma'));
      assert.equal(names.includes('Browse Beta'), seesAll, 'office-bound roles do not see the Library service');
      assert.ok(!names.includes('Browse Hidden'));
      const alpha = body.items.find((s) => s.service_name === 'Browse Alpha');
      assert.equal(alpha.office_name, 'Registrar');
      assert.equal(alpha.office_code, 'REG');
      assert.equal(alpha.classification, 'SIMPLE');
      assert.equal(alpha.current_standard.duration_minutes, 7);
      assert.equal(alpha.service_scope, 'EXTERNAL');
      assert.deepEqual(alpha.transaction_types, ['G2C']);
      assert.ok('page' in body && 'page_size' in body && 'total' in body);
    }
    assert.equal((await callJson(listRoute, req('GET', '/services'))).status, 401);
  });

  it('AC2: office, classification, status and search filters narrow the list; pagination works', async () => {
    const byOffice = await list(`?office_id=${library.office_id}&search=Browse`);
    assert.deepEqual(byOffice.body.items.map((s) => s.service_name), ['Browse Beta']);
    const byClass = await list('?classification=HIGHLY_TECHNICAL&search=Browse');
    assert.deepEqual(byClass.body.items.map((s) => s.service_name), ['Browse Gamma']);
    const byScope = await list('?service_scope=INTERNAL&search=Browse');
    assert.deepEqual(byScope.body.items.map((s) => s.service_name), ['Browse Beta']);
    const byOfficeName = await list('?search=library');
    assert.ok(byOfficeName.body.items.every((s) => s.office_name === 'Library') && byOfficeName.body.total >= 1);
    const byCode = await list('?search=' + encodeURIComponent(inactive.service_code));
    assert.equal(byCode.body.total, 0, 'status defaults to active');
    const inactiveOnly = await list('?status=inactive&search=Browse');
    assert.deepEqual(inactiveOnly.body.items.map((s) => s.service_name), ['Browse Hidden']);
    const all = await list('?status=all&search=Browse');
    assert.equal(all.body.total, 4);
    const paged = await list('?search=Browse&page=2&page_size=2');
    assert.equal(paged.body.items.length, 1);
    assert.equal(paged.body.total, 3);
    assert.equal(paged.body.page, 2);
    assert.equal(paged.body.page_size, 2);
    assert.equal((await list('?classification=NOPE')).status, 400);
    assert.equal((await list('?service_scope=PUBLIC')).status, 400);
    assert.equal((await list('?status=weird')).status, 400);
    assert.equal((await list('?office_id=abc')).status, 400);
    assert.equal((await list('?page=0')).status, 400);
    assert.equal((await list('?page_size=1000')).status, 400);
    const wildcard = await list('?search=%25');
    assert.equal(wildcard.body.total, 0, '% is searched literally');
  });

  it('AC3: the service detail shows the current standard, checklist and procedure steps', async () => {
    const service = await makeService({ service_name: 'Browse Detail', processing_steps: 'Step list', fees: 'None', who_may_avail: 'PUP Students' });
    await addDoc(service.service_id, { document_name: 'Form A', is_mandatory: true, notes: 'two copies' });
    const { status, body } = await detail(service.service_id, tokens.officeStaffA);
    assert.equal(status, 200);
    assert.equal(body.service.current_standard.duration_minutes, 7);
    assert.equal(body.service.processing_steps, 'Step list');
    assert.equal(body.service.fees, 'None');
    assert.equal(body.service.who_may_avail, 'PUP Students');
    assert.equal(body.standards.length, 1);
    assert.deepEqual(Object.keys(body.documents[0]).sort(), ['document_id', 'document_name', 'is_mandatory', 'notes', 'service_id']);
    assert.equal(body.documents[0].notes, 'two copies');
  });

  it('AC4: Office Staff never see inactive services (list, status filter, detail, history)', async () => {
    for (const token of [tokens.officeStaffA, tokens.officeHeadA, tokens.executive]) {
      const inactiveFilter = await list('?status=inactive&search=Browse', token);
      assert.ok(inactiveFilter.body.items.length > 0 && inactiveFilter.body.items.every((s) => s.is_active), 'status=inactive falls back to active only');
      assert.ok(!inactiveFilter.body.items.some((s) => s.service_name === 'Browse Hidden'));
      const allFilter = await list('?status=all&search=Browse', token);
      assert.ok(!allFilter.body.items.some((s) => s.service_name === 'Browse Hidden'));
      assert.equal((await detail(inactive.service_id, token)).status, 404);
      const history = await callJson(listStandards, req('GET', `/services/${inactive.service_id}/standards`, { token }), ctx(inactive.service_id));
      assert.equal(history.status, 404);
    }
    assert.equal((await detail(inactive.service_id, SA())).status, 200);
    assert.equal((await detail('not-a-uuid')).status, 404);
  });

  it('AC5: the list answers 30 concurrent users within 3 seconds', async () => {
    const started = Date.now();
    const responses = await Promise.all(Array.from({ length: 30 }, () => list('?page_size=20', tokens.officeStaffA)));
    assert.ok(responses.every((r) => r.status === 200));
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });
});

describe('CC013 public service browse (no login)', () => {
  const pub = (path = '') => callJson(publicList, req('GET', `/public/services${path}`));
  let detailService;
  before(async () => {
    await makeService({ service_name: 'Public Minutes', standard: validStandard({ duration_minutes: 7 }) });
    await makeService({ service_name: 'Public Hours', standard: validStandard({ duration_hours: 4, duration_minutes: 0 }) }, library);
    await makeService({ service_name: 'Public Days', standard: validStandard({ duration_days: 3, duration_minutes: 0 }) });
    await makeService({ service_name: 'Public Single Day', standard: validStandard({ duration_days: 1, duration_minutes: 0 }) });
    await makeService({ service_name: 'Public Single Minute', standard: validStandard({ duration_minutes: 1 }) });
    await makeService({ service_name: 'Public Mixed Duration', standard: validStandard({ duration_days: 2, duration_hours: 5, duration_minutes: 30 }) });
    await makeService({ service_name: 'Public Future Only', standard: validStandard({ effective_from: addDays(today(), 3) }) });
    const gone = await makeService({ service_name: 'Public Gone' });
    await deactivateService(req('PATCH', `/services/${gone.service_id}/deactivate`, { token: SA() }), ctx(gone.service_id));
    detailService = await makeService({
      service_name: 'Public Detail',
      processing_steps: 'Do this, then that.',
      fees: 'PHP 50 per page',
      who_may_avail: 'PUP Students',
    });
    await addDoc(detailService.service_id, { document_name: 'Mandatory Form', is_mandatory: true });
    await addDoc(detailService.service_id, { document_name: 'Optional Photo', is_mandatory: false, notes: 'if available' });
  });

  it('AC1: with no session, services list with office, classification and "7 minutes" / "4 hours" / "3 working days"', async () => {
    await publicLimiter.reset();
    const { status, body } = await pub('?search=Public');
    assert.equal(status, 200);
    const text = (name) => body.items.find((s) => s.service_name === name);
    assert.equal(text('Public Minutes').standard_text, '7 minutes');
    assert.equal(text('Public Hours').standard_text, '4 hours');
    assert.equal(text('Public Days').standard_text, '3 working days');
    assert.equal(text('Public Single Day').standard_text, '1 working day');
    assert.equal(text('Public Single Minute').standard_text, '1 minute');
    assert.equal(text('Public Mixed Duration').standard_text, '2 working days, 5 hours, 30 minutes');
    assert.equal(text('Public Hours').office_name, 'Library');
    assert.equal(text('Public Hours').classification, 'SIMPLE');
    assert.deepEqual([text('Public Hours').duration_days, text('Public Hours').duration_hours, text('Public Hours').duration_minutes], [0, 4, 0]);
    assert.ok(!text('Public Future Only'), 'needs a standard in force today');
    assert.equal(body.page, 1);
    assert.ok(body.page_size >= 1 && body.total >= 6);
    const paged = await pub('?search=Public&page_size=2&page=2');
    assert.equal(paged.body.items.length, 2);
    assert.equal((await pub('?page=x')).status, 400);
  });

  it('AC2: search by service name or office name; no match returns an empty list', async () => {
    await publicLimiter.reset();
    assert.deepEqual((await pub('?search=public%20hours')).body.items.map((s) => s.service_name), ['Public Hours']);
    const byOffice = await pub('?search=Libra');
    assert.ok(byOffice.body.total >= 1 && byOffice.body.items.every((s) => s.office_name === 'Library'));
    const none = await pub('?search=zzzz-no-such-service');
    assert.deepEqual([none.status, none.body.items, none.body.total], [200, [], 0]);
  });

  it('AC3: the detail shows the checklist (mandatory marked) and procedure steps', async () => {
    await publicLimiter.reset();
    const { status, body } = await callJson(publicDetail, req('GET', `/public/services/${detailService.service_id}`), ctx(detailService.service_id));
    assert.equal(status, 200);
    assert.equal(body.service.processing_steps, 'Do this, then that.');
    assert.equal(body.service.fees, 'PHP 50 per page');
    assert.equal(body.service.who_may_avail, 'PUP Students');
    assert.equal(body.service.standard_text, '7 minutes');
    assert.equal(body.service.documents.length, 2);
    assert.deepEqual(body.service.documents[0], { document_name: 'Mandatory Form', is_mandatory: true, notes: null });
    assert.deepEqual(body.service.documents[1], { document_name: 'Optional Photo', is_mandatory: false, notes: 'if available' });
    assert.equal((await callJson(publicDetail, req('GET', '/public/services/not-a-uuid'), ctx('not-a-uuid'))).status, 404);
    assert.equal((await callJson(publicDetail, req('GET', `/public/services/${randomUUID()}`), ctx(randomUUID()))).status, 404);
  });

  it('AC4: inactive services (and ones with no standard in force) never appear, in list or detail', async () => {
    await publicLimiter.reset();
    const gone = await ds.query(`SELECT service_id FROM services WHERE service_name = 'Public Gone'`);
    const future = await ds.query(`SELECT service_id FROM services WHERE service_name = 'Public Future Only'`);
    assert.equal((await pub('?search=Public%20Gone')).body.total, 0);
    assert.equal((await pub('?search=Public%20Future')).body.total, 0);
    assert.equal((await callJson(publicDetail, req('GET', `/public/services/${gone[0].service_id}`), ctx(gone[0].service_id))).status, 404);
    assert.equal((await callJson(publicDetail, req('GET', `/public/services/${future[0].service_id}`), ctx(future[0].service_id))).status, 404);
  });

  it('AC5: responses contain no internal fields', async () => {
    await publicLimiter.reset();
    const listed = await pub('?search=Public');
    const one = await callJson(publicDetail, req('GET', `/public/services/${detailService.service_id}`), ctx(detailService.service_id));
    assert.deepEqual(Object.keys(listed.body).sort(), ['items', 'page', 'page_size', 'total']);
    for (const item of listed.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['classification', 'duration_days', 'duration_hours', 'duration_minutes', 'office_name', 'service_id', 'service_name', 'standard_text']);
    }
    assert.deepEqual(Object.keys(one.body.service).sort(), ['classification', 'documents', 'fees', 'office_name', 'processing_steps', 'service_id', 'service_name', 'standard_text', 'who_may_avail']);
    assert.deepEqual(Object.keys(one.body.service.documents[0]).sort(), ['document_name', 'is_mandatory', 'notes']);
    const text = JSON.stringify([listed.body, one.body]);
    for (const banned of ['office_id', 'office_code', 'service_code', 'service_scope', 'transaction_types', 'is_active', 'created_at', 'updated_at', 'standard_id', 'document_id', 'charter_reference', 'version_no', 'effective_', 'measurement_type', registrar.office_id, 'REG-']) {
      assert.ok(!text.includes(banned), `public response leaks ${banned}`);
    }
  });

  it('AC6: requests over the rate limit get 429 with a readable message and Retry-After; other clients are unaffected', async () => {
    process.env.PUBLIC_RATE_LIMIT = '3';
    process.env.PUBLIC_RATE_WINDOW_SECONDS = '60';
    await publicLimiter.reset();
    try {
      const asClient = (ip, handler = publicList, path = '/public/services') => callJson(handler, req('GET', path, { headers: { 'x-forwarded-for': ip } }), ctx(detailService.service_id));
      for (let i = 0; i < 3; i += 1) assert.equal((await asClient('203.0.113.7')).status, 200);
      const blocked = await asClient('203.0.113.7');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'RATE_LIMITED');
      assert.match(blocked.body.error.message, /too many requests.*try again/i);
      assert.ok(blocked.body.error.correlation_id);
      const retry = Number(blocked.headers.get('retry-after'));
      assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After ${retry}`);
      const detailBlocked = await asClient('203.0.113.7', publicDetail, `/public/services/${detailService.service_id}`);
      assert.equal(detailBlocked.status, 429, 'list and detail share one budget');
      assert.equal((await asClient('198.51.100.9')).status, 200);
    } finally {
      delete process.env.PUBLIC_RATE_LIMIT;
      delete process.env.PUBLIC_RATE_WINDOW_SECONDS;
      await publicLimiter.reset();
    }
  });

  it('the limiter window resets with time (fake clock), counting in the rate_limit_hits table', async () => {
    const { createDbStore, createRateLimiter } = await import('ccms-shared');
    const { getDb } = await import('../src/lib/data-source.js');
    let now = 1_000_000;
    const limiter = createRateLimiter({ now: () => now, store: createDbStore(getDb) });
    await limiter.reset();
    const rule = { limit: 2, windowMs: 10_000 };
    assert.equal((await limiter.check('k', rule)).allowed, true);
    assert.equal((await limiter.check('k', rule)).allowed, true);
    now += 4_000;
    const denied = await limiter.check('k', rule);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 6);
    now += 6_000;
    assert.equal((await limiter.check('k', rule)).allowed, true);
    const [{ n }] = await (await getDb()).query("SELECT count(*)::int AS n FROM rate_limit_hits WHERE key = 'k'");
    assert.equal(n, 1, 'one row per key');
    await limiter.reset();
  });
});

describe('TT1 standard as-of lookup', () => {
  it('AC1: returns the version in force on the given Manila date, with the service fields', async () => {
    const service = await makeService({ service_name: 'AsOf Service', standard: validStandard({ effective_from: '2026-01-01', duration_minutes: 5 }) });
    const id = service.service_id;
    // Future-dated versions only need effective_from >= today; add one, then check the boundaries.
    const v2 = await addStandard(id, validStandard({ effective_from: addDays(today(), 10), duration_days: 1, duration_hours: 8, duration_minutes: 30 }));
    const first = await asOf(id, '2026-01-01');
    assert.deepEqual(first.body, {
      standard_id: service.current_standard.standard_id,
      duration_days: 0,
      duration_hours: 0,
      duration_minutes: 5,
      service_code: service.service_code,
      service_name: 'AsOf Service',
      office_id: registrar.office_id,
    });
    const lastDay = await asOf(id, addDays(today(), 9));
    assert.equal(lastDay.body.standard_id, service.current_standard.standard_id);
    const firstDay = await asOf(id, addDays(today(), 10));
    assert.equal(firstDay.body.standard_id, v2.body.standard.standard_id);
    assert.equal((await asOf(id, addDays(today(), 400))).body.standard_id, v2.body.standard.standard_id, 'open-ended version');
    assert.equal((await asOf(id, null)).body.standard_id, service.current_standard.standard_id, 'defaults to today');
    assert.equal((await asOf(id, '2025-12-31')).status, 404, 'before the first version');
    assert.equal((await asOf(id, 'tomorrow')).status, 400);
    assert.equal((await asOf(id, '2026-02-30')).status, 400);
  });

  it('is callable with the service key or any signed-in token, and with nothing else', async () => {
    const service = await makeService();
    const path = `/services/${service.service_id}/standard`;
    const call = (opts) => callJson(asOfRoute, req('GET', path, opts), ctx(service.service_id));
    assert.equal((await call({ headers: { 'x-service-key': SERVICE_KEY } })).status, 200);
    for (const token of [tokens.superAdmin, tokens.executive, tokens.officeHeadA, tokens.officeStaffA]) assert.equal((await call({ token })).status, 200);
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ headers: { 'x-service-key': 'wrong' } })).status, 401);
  });

  it('AC2: an inactive service returns 409 "Service inactive" (also to the service key)', async () => {
    const service = await makeService();
    const id = service.service_id;
    await deactivateService(req('PATCH', `/services/${id}/deactivate`, { token: SA() }), ctx(id));
    for (const opts of [{ headers: { 'x-service-key': SERVICE_KEY } }, { token: tokens.officeStaffA }]) {
      const { status, body } = await callJson(asOfRoute, req('GET', `/services/${id}/standard`, opts), ctx(id));
      assert.equal(status, 409);
      assert.equal(body.error.message, 'Service inactive');
    }
  });

  it('AC3: an unknown service returns 404', async () => {
    const id = randomUUID();
    assert.equal((await asOf(id, today(), { headers: { 'x-service-key': SERVICE_KEY } })).status, 404);
    assert.equal((await asOf('not-a-uuid', today())).status, 404);
  });

  it('AC4: responds within 2 seconds', async () => {
    const service = await makeService();
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => asOf(service.service_id, today())));
    assert.ok(results.every((r) => r.status === 200));
    assert.ok(Date.now() - started < 2000);
  });
});

describe('TT2 seeding script with duplicate guard', () => {
  const SEED = {
    offices: [
      { office_code: 'SDA', office_name: 'SEED OFFICE A (test)' },
      { office_code: 'SDB', office_name: 'SEED OFFICE B (test)' },
    ],
    services: [
      {
        office_code: 'SDA',
        service_code: 'SDA-ONE-001',
        service_name: 'Seed Service One',
        classification: 'SIMPLE',
        service_scope: 'EXTERNAL',
        transaction_types: ['G2C'],
        processing_steps: 'Steps',
        standard: { duration_days: 0, duration_hours: 0, duration_minutes: 5, effective_from: '2026-01-01', charter_reference: 'ref' },
        documents: [{ document_name: 'Seed Doc', is_mandatory: true }],
      },
      {
        office_code: 'SDB',
        service_code: 'SDB-ONE-001',
        service_name: 'Seed Service One',
        classification: 'COMPLEX',
        service_scope: 'INTERNAL',
        transaction_types: ['G2B', 'G2G'],
        standard: { duration_days: 0, duration_hours: 2, duration_minutes: 0, effective_from: '2026-01-01', charter_reference: 'ref' },
      },
    ],
  };
  const counts = async () => {
    const one = async (table) => (await ds.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
    return { offices: await one('offices'), services: await one('services'), standards: await one('service_standards'), documents: await one('required_documents'), audit: await one('audit_outbox') };
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  it('AC1: a dry run on a file containing a duplicate reports it and writes nothing', async () => {
    const data = clone(SEED);
    data.services.push({ ...clone(data.services[0]), service_code: 'SDA-ONE-002', service_name: '  SEED   service ONE ' }); // same office + normalised name
    const before = await counts();
    const result = await runSeed(ds, data, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.counts.services_created, 2, 'what would be created');
    assert.equal(result.counts.services_duplicate, 1);
    assert.equal(result.counts.errors, 0);
    const dup = result.rows.find((r) => r.outcome === 'duplicate');
    assert.match(dup.message, /already has a service with this name/);
    assert.deepEqual(await counts(), before);
  });

  it('AC2: running a clean file twice adds nothing the second time; the same name in another office is not a duplicate', async () => {
    const before = await counts();
    const first = await runSeed(ds, clone(SEED));
    assert.deepEqual([first.counts.offices_created, first.counts.services_created, first.counts.errors], [2, 2, 0]);
    const afterFirst = await counts();
    assert.deepEqual([afterFirst.offices - before.offices, afterFirst.services - before.services, afterFirst.standards - before.standards, afterFirst.documents - before.documents], [2, 2, 2, 1]);
    assert.ok(afterFirst.audit > before.audit, 'seeded rows are audited');

    const second = await runSeed(ds, clone(SEED));
    assert.deepEqual([second.counts.offices_created, second.counts.services_created], [0, 0]);
    assert.deepEqual([second.counts.offices_duplicate, second.counts.services_duplicate, second.counts.errors], [2, 2, 0]);
    assert.deepEqual(await counts(), afterFirst);
  });

  it('applies the same validation as the API, reports bad rows and still loads the good ones', async () => {
    const seedService = (over = {}) => ({
      service_scope: 'EXTERNAL',
      transaction_types: ['G2C'],
      standard: { duration_days: 0, duration_hours: 1, duration_minutes: 0, effective_from: '2026-01-01', charter_reference: 'r' },
      ...over,
    });
    const data = {
      offices: [{ office_code: 'SDC', office_name: 'SEED OFFICE C' }],
      services: [
        seedService({ office_code: 'SDC', service_code: 'SDC-OK-001', service_name: 'Valid Seed Row', classification: 'SIMPLE' }),
        seedService({ office_code: 'SDC', service_code: 'SDC-BAD-001', service_name: 'Bad Class', classification: 'EASY' }),
        seedService({ office_code: 'NOPE', service_code: 'NOPE-X-001', service_name: 'No Office', classification: 'SIMPLE' }),
        seedService({ office_code: 'SDC', service_code: 'SDC-CODE-001', service_name: 'Code Clash', classification: 'SIMPLE', standard: { duration_days: 0, duration_hours: 0, duration_minutes: 0, effective_from: '2026-01-01', charter_reference: 'r' } }),
        seedService({ office_code: 'SDC', service_code: 'SDC-OK-001', service_name: 'Same Code Other Name', classification: 'SIMPLE' }),
        seedService({ office_code: 'SDC', service_code: 'SDC-DOC-001', service_name: 'Bad Doc Row', classification: 'SIMPLE', documents: [{ document_name: '' }] }),
      ],
    };
    const result = await runSeed(ds, data);
    assert.equal(result.counts.services_created, 1);
    assert.equal(result.counts.errors, 5);
    const errors = result.rows.filter((r) => r.outcome === 'error');
    assert.ok(errors.some((r) => /classification/i.test(r.message)));
    assert.ok(errors.some((r) => r.message === 'Office not found or inactive'));
    assert.ok(errors.some((r) => /Service code already exists/.test(r.message)));
    assert.equal((await ds.query(`SELECT count(*)::int AS n FROM services WHERE service_name = 'Bad Doc Row'`))[0].n, 0, 'a failing row leaves nothing behind');
    assert.equal((await ds.query(`SELECT count(*)::int AS n FROM services WHERE service_name = 'Valid Seed Row'`))[0].n, 1);
    await assert.rejects(() => runSeed(ds, { services: 'nope' }), /list of objects/);
  });

  it('does not mark a failed service name as seen before a later valid row commits', async () => {
    const base = {
      office_code: 'SDD',
      service_name: 'Retry This Seed Name',
      classification: 'SIMPLE',
      service_scope: 'EXTERNAL',
      transaction_types: ['G2C'],
      standard: { duration_days: 0, duration_hours: 0, duration_minutes: 5, effective_from: '2026-01-01', charter_reference: 'r' },
    };
    const result = await runSeed(ds, {
      offices: [{ office_code: 'SDD', office_name: 'SEED OFFICE D' }],
      services: [
        { ...base, service_code: 'SDD-ONE-001', documents: [{ document_name: '' }] },
        { ...base, service_code: 'SDD-ONE-002' },
      ],
    });
    assert.equal(result.counts.errors, 1);
    assert.equal(result.counts.services_created, 1);
    assert.equal(result.counts.services_duplicate, 0);
    assert.equal((await ds.query(`SELECT count(*)::int AS n FROM services WHERE service_name = 'Retry This Seed Name'`))[0].n, 1);
  });

  it('the shipped seed/sample.json is clearly marked placeholder data and loads cleanly', async () => {
    const data = JSON.parse(readFileSync(new URL('../seed/sample.json', import.meta.url), 'utf8'));
    assert.match(data._README, /SAMPLE \/ PLACEHOLDER/);
    assert.ok(JSON.stringify(data).toLowerCase().includes('placeholder'));
    const dry = await runSeed(ds, data, { dryRun: true });
    assert.equal(dry.counts.errors, 0);
    assert.ok(dry.counts.services_created >= 3);
  });

  it('the CLI supports --dry-run (writes nothing), a real run, and a safe re-run', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'seed-'));
    try {
      const file = join(dir, 'cli.json');
      await writeFile(file, JSON.stringify({ offices: [{ office_code: 'CLI', office_name: 'CLI Office' }], services: [{ office_code: 'CLI', service_code: 'CLI-ONE-001', service_name: 'CLI Service', classification: 'SIMPLE', service_scope: 'EXTERNAL', transaction_types: ['G2C'], standard: { duration_days: 0, duration_hours: 1, duration_minutes: 0, effective_from: '2026-01-01', charter_reference: 'r' } }] }));
      const run = (...args) =>
        promisify(execFile)(process.execPath, ['scripts/seed.js', '--file', file, ...args], {
          cwd: new URL('..', import.meta.url).pathname,
          env: { ...process.env, DATABASE_URL: testDb.url, DB_SYNCHRONIZE: 'false', SERVICE_KEY: '', LOGS_SERVICE_URL: '' },
        });
      const n = async () => (await ds.query(`SELECT count(*)::int AS n FROM services WHERE service_name = 'CLI Service'`))[0].n;
      const dry = await run('--dry-run');
      assert.match(dry.stdout, /DRY RUN: nothing was written/);
      assert.match(dry.stdout, /Would create: 1 office\(s\), 1 service\(s\)/);
      assert.equal(await n(), 0);
      await run();
      assert.equal(await n(), 1);
      const again = await run();
      assert.match(again.stdout, /Created: 0 office\(s\), 0 service\(s\)\. Duplicates skipped: 1 office\(s\), 1 service\(s\)/);
      assert.equal(await n(), 1);
      await assert.rejects(() => promisify(execFile)(process.execPath, ['scripts/seed.js'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, DATABASE_URL: testDb.url } }), /Usage/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const wrapped = (handler, path, options = {}, context = ctx(randomUUID())) => (token) => handler(req(options.method ?? 'GET', path, { token, body: options.body }), context);
const boundaryServiceId = randomUUID();
const boundaryDocId = randomUUID();
const boundaryStandardId = randomUUID();
runBoundarySuite({
  name: 'catalogue services',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    { name: 'POST /services', write: true, superAdminOnly: true, invoke: (token) => postService(req('POST', '/services', { token, body: { ...serviceBody(), service_code: `REG-BND-${Math.floor(Math.random() * 900 + 100)}`, service_name: `Boundary ${randomUUID()}` } })) },
    { name: 'PUT /services/:id', write: true, superAdminOnly: true, invoke: wrapped(putService, `/services/${boundaryServiceId}`, { method: 'PUT', body: { office_id: randomUUID() } }, ctx(boundaryServiceId)) },
    { name: 'PATCH /services/:id/deactivate', write: true, superAdminOnly: true, invoke: wrapped(deactivateService, `/services/${boundaryServiceId}/deactivate`, { method: 'PATCH' }, ctx(boundaryServiceId)) },
    { name: 'PATCH /services/:id/reactivate', write: true, superAdminOnly: true, invoke: wrapped(reactivateService, `/services/${boundaryServiceId}/reactivate`, { method: 'PATCH' }, ctx(boundaryServiceId)) },
    { name: 'POST /services/:id/standards', write: true, superAdminOnly: true, invoke: wrapped(postStandard, `/services/${boundaryServiceId}/standards`, { method: 'POST', body: validStandard() }, ctx(boundaryServiceId)) },
    { name: 'DELETE /services/:id/standards/:standardId', write: true, superAdminOnly: true, invoke: wrapped(deleteStandard, `/services/${boundaryServiceId}/standards/${boundaryStandardId}`, { method: 'DELETE' }, ctx(boundaryServiceId, { standardId: boundaryStandardId })) },
    { name: 'POST /services/:id/documents', write: true, superAdminOnly: true, invoke: wrapped(postDocument, `/services/${boundaryServiceId}/documents`, { method: 'POST', body: { document_name: 'X' } }, ctx(boundaryServiceId)) },
    { name: 'PUT /services/:id/documents/:documentId', write: true, superAdminOnly: true, invoke: wrapped(putDocument, `/services/${boundaryServiceId}/documents/${boundaryDocId}`, { method: 'PUT', body: { document_name: 'X' } }, ctx(boundaryServiceId, { documentId: boundaryDocId })) },
    { name: 'DELETE /services/:id/documents/:documentId', write: true, superAdminOnly: true, invoke: wrapped(deleteDocument, `/services/${boundaryServiceId}/documents/${boundaryDocId}`, { method: 'DELETE' }, ctx(boundaryServiceId, { documentId: boundaryDocId })) },
    { name: 'GET /services (readable by every signed-in role)', write: false, officeScoped: false, invoke: (token) => listRoute(req('GET', '/services', { token })) },
  ],
});

describe('service catalogue read access by office', () => {
  let regSvc;
  let libSvc;
  let regInactive;
  let libInactive;
  const OFFICE_BOUND = () => [tokens.officeHeadA, tokens.officeStaffA];
  const history = (id, token) => callJson(listStandards, req('GET', `/services/${id}/standards`, { token }), ctx(id));

  before(async () => {
    regSvc = await makeService({ service_name: 'Scope Reg Service' }, registrar);
    libSvc = await makeService({ service_name: 'Scope Lib Service' }, library);
    regInactive = await makeService({ service_name: 'Scope Reg Inactive' }, registrar);
    libInactive = await makeService({ service_name: 'Scope Lib Inactive' }, library);
    for (const s of [regInactive, libInactive]) {
      await deactivateService(req('PATCH', `/services/${s.service_id}/deactivate`, { token: SA() }), ctx(s.service_id));
    }
  });

  it('GET /services: Office Head / Office Staff only get their own office, including search, paging and total', async () => {
    for (const token of OFFICE_BOUND()) {
      const all = await list('?page_size=100', token);
      assert.equal(all.status, 200);
      assert.ok(all.body.total > 0 && all.body.items.every((s) => s.office_id === registrar.office_id));
      assert.equal(all.body.total, (await list(`?office_id=${registrar.office_id}&status=active`)).body.total);
      const search = await list('?search=Scope', token);
      assert.deepEqual(search.body.items.map((s) => s.service_name), ['Scope Reg Service']);
      assert.equal(search.body.total, 1);
      assert.equal((await list('?search=Scope%20Lib', token)).body.total, 0);
      assert.equal((await list('?search=library', token)).body.total, 0, 'office-name search cannot reach another office');
      const paged = await list('?page=2&page_size=1', token);
      assert.equal(paged.body.total, all.body.total);
      assert.equal(paged.body.items.length, 1);
      assert.equal((await list(`?office_id=${registrar.office_id}&search=Scope`, token)).body.total, 1);
    }
  });

  it('GET /services: asking for another office is 403 in the standard error format, with no data', async () => {
    for (const token of OFFICE_BOUND()) {
      const { status, body } = await list(`?office_id=${library.office_id}`, token);
      assert.equal(status, 403);
      assert.equal(body.error.code, 'FORBIDDEN');
      assert.ok(body.error.message && body.error.correlation_id && body.error.timestamp);
      assert.equal(body.items, undefined);
      assert.equal(body.total, undefined);
    }
  });

  it('GET /services: Office Head / Office Staff without an office in the token get 403, never every office', async () => {
    const noOffice = await keys.signToken({ role: ROLES.OFFICE_STAFF });
    assert.equal((await list('', noOffice)).status, 403);
  });

  it('GET /services: Super Admin and Executive see every office and may filter by any office', async () => {
    for (const token of [tokens.superAdmin, tokens.executive]) {
      const names = (await list('?search=Scope', token)).body.items.map((s) => s.service_name);
      assert.deepEqual(names.sort(), ['Scope Lib Service', 'Scope Reg Service']);
      assert.equal((await list(`?office_id=${library.office_id}&search=Scope`, token)).body.total, 1);
      assert.equal((await list(`?office_id=${registrar.office_id}&search=Scope`, token)).body.total, 1);
    }
  });

  it('GET /services/:id and /standards: another office is 403 with no data; own office and the wide roles get 200', async () => {
    for (const token of OFFICE_BOUND()) {
      const other = await detail(libSvc.service_id, token);
      assert.equal(other.status, 403);
      assert.equal(other.body.error.code, 'FORBIDDEN');
      assert.ok(!JSON.stringify(other.body).includes(libSvc.service_name));
      const otherHistory = await history(libSvc.service_id, token);
      assert.equal(otherHistory.status, 403);
      assert.equal(otherHistory.body.items, undefined);
      assert.equal((await detail(regSvc.service_id, token)).status, 200);
      assert.equal((await history(regSvc.service_id, token)).status, 200);
    }
    for (const token of [tokens.superAdmin, tokens.executive]) {
      for (const s of [regSvc, libSvc]) {
        assert.equal((await detail(s.service_id, token)).status, 200);
        assert.equal((await history(s.service_id, token)).status, 200);
      }
    }
  });

  it('inactive services stay Super Admin only: 404 for everyone else, whatever the office', async () => {
    for (const token of [...OFFICE_BOUND(), tokens.executive]) {
      for (const s of [regInactive, libInactive]) {
        assert.equal((await detail(s.service_id, token)).status, 404);
        assert.equal((await history(s.service_id, token)).status, 404);
      }
    }
    for (const s of [regInactive, libInactive]) {
      assert.equal((await detail(s.service_id, SA())).status, 200);
      assert.equal((await history(s.service_id, SA())).status, 200);
    }
  });

  it('GET /services/:id/standard?asOf=: service key reaches any office; office-bound tokens get 403 for another office', async () => {
    const key = { headers: { 'x-service-key': SERVICE_KEY } };
    for (const s of [regSvc, libSvc]) assert.equal((await asOf(s.service_id, null, key)).status, 200);
    for (const token of OFFICE_BOUND()) {
      const other = await asOf(libSvc.service_id, null, { token });
      assert.equal(other.status, 403);
      assert.equal(other.body.standard_id, undefined);
      assert.equal((await asOf(regSvc.service_id, null, { token })).status, 200);
    }
    for (const token of [tokens.superAdmin, tokens.executive]) {
      for (const s of [regSvc, libSvc]) assert.equal((await asOf(s.service_id, null, { token })).status, 200);
    }
  });

  it('write endpoints stay Super Admin only and public endpoints stay open to all offices', async () => {
    for (const token of [...OFFICE_BOUND(), tokens.executive]) {
      for (const s of [regSvc, libSvc]) {
        const put = await callJson(putService, req('PUT', `/services/${s.service_id}`, { token, body: serviceBody(registrar) }), ctx(s.service_id));
        assert.equal(put.status, 403);
      }
      assert.equal((await addStandard(regSvc.service_id, validStandard({ effective_from: addDays(today(), 3) }), token)).status, 403);
    }
    await publicLimiter.reset();
    for (const s of [regSvc, libSvc]) assert.equal((await callJson(publicDetail, req('GET', `/public/services/${s.service_id}`), ctx(s.service_id))).status, 200);
    const publicNames = (await callJson(publicList, req('GET', '/public/services?search=Scope%20'))).body.items.map((s) => s.service_name);
    assert.deepEqual(publicNames.sort(), ['Scope Lib Service', 'Scope Reg Service']);
  });
});

// Office A = Registrar (the office in the Office Head / Office Staff tokens), office B = Library.
let scopedServices;
// Created lazily: the database and offices only exist once the file-level before() has run.
async function scopedId(target) {
  scopedServices ??= {
    own: (await makeService({ service_name: 'Boundary Read Own' }, registrar)).service_id,
    other: (await makeService({ service_name: 'Boundary Read Other Secret' }, library)).service_id,
  };
  return scopedServices[target];
}
runBoundarySuite({
  name: 'catalogue service reads',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'GET /services?office_id=',
      invoke: (token, target) => listRoute(req('GET', `/services?office_id=${target === 'own' ? registrar.office_id : library.office_id}`, { token })),
      otherOfficeMarker: 'Boundary Read Other Secret',
    },
    {
      name: 'GET /services/:id',
      invoke: async (token, target) => { const id = await scopedId(target); return getService(req('GET', `/services/${id}`, { token }), ctx(id)); },
      otherOfficeMarker: 'Boundary Read Other Secret',
    },
    {
      name: 'GET /services/:id/standards',
      invoke: async (token, target) => { const id = await scopedId(target); return listStandards(req('GET', `/services/${id}/standards`, { token }), ctx(id)); },
    },
    {
      name: 'GET /services/:id/standard?asOf=',
      invoke: async (token, target) => { const id = await scopedId(target); return asOfRoute(req('GET', `/services/${id}/standard`, { token }), ctx(id)); },
      otherOfficeMarker: 'Boundary Read Other Secret',
    },
  ],
});

describe('catalogue reads: same office 200, Executive and Super Admin 200 on both offices', () => {
  it('returns 200 for the own office and for the wide roles on either office', async () => {
    const calls = [
      (t, id) => getService(req('GET', `/services/${id}`, { token: t }), ctx(id)),
      (t, id) => listStandards(req('GET', `/services/${id}/standards`, { token: t }), ctx(id)),
      (t, id) => asOfRoute(req('GET', `/services/${id}/standard`, { token: t }), ctx(id)),
    ];
    for (const call of calls) {
      for (const token of [tokens.officeHeadA, tokens.officeStaffA]) assert.equal((await call(token, await scopedId('own'))).status, 200);
      for (const token of [tokens.superAdmin, tokens.executive]) {
        for (const target of ['own', 'other']) assert.equal((await call(token, await scopedId(target))).status, 200);
      }
    }
  });
});
