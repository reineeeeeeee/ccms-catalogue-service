// Calendar reads are open to all four roles; only Super Admin writes. Exceptions and holidays for
// Office Head / Office Staff are campus-wide plus their own office.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { GET as getHolidays } from '../src/app/api/holidays/route.js';
import { DELETE as deleteException, PUT as putException } from '../src/app/api/exceptions/[id]/route.js';
import { GET as listExceptions, POST as postException } from '../src/app/api/exceptions/route.js';
import { GET as getSchedule, PUT as putSchedule } from '../src/app/api/schedule/route.js';
import { GET as statusRoute } from '../src/app/api/sync/status/route.js';
import { PUT as putTerm } from '../src/app/api/terms/[id]/route.js';
import { GET as listTerms, POST as postTerm } from '../src/app/api/terms/route.js';
import { CHARTER_DAYS, OFFICE_A, OFFICE_B, ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(async () => env?.teardown());

const ROLES_UNDER_TEST = () => [
  ['Super Admin', tokens.superAdmin],
  ['Executive', tokens.executive],
  ['Office Head', tokens.officeHeadA],
  ['Office Staff', tokens.officeStaffA],
];
const NON_ADMIN = () => ROLES_UNDER_TEST().slice(1);
const entry = (exception_date, extra = {}) => ({ exception_date, exception_type: 'LOCAL_HOLIDAY', description: 'Entry', ...extra });

describe('calendar reads are open to all four roles', () => {
  it('GET /schedule, /exceptions, /terms and /holidays answer 200 for every role', async () => {
    const calls = {
      '/schedule': (token) => getSchedule(req('GET', '/schedule', { token })),
      '/exceptions': (token) => listExceptions(req('GET', '/exceptions', { token })),
      '/terms': (token) => listTerms(req('GET', '/terms', { token })),
      '/holidays': (token) => getHolidays(req('GET', '/holidays?from=2026-01-01&to=2026-12-31', { token })),
    };
    for (const [path, call] of Object.entries(calls)) {
      for (const [label, token] of ROLES_UNDER_TEST()) assert.equal((await call(token)).status, 200, `${label} ${path}`);
      assert.equal((await call(undefined)).status, 401, `no token ${path}`);
    }
  });

  it('GET /sync/status is Super Admin only (RBAC 4.3): other roles get 403, no token 401', async () => {
    assert.equal((await statusRoute(req('GET', '/sync/status', { token: tokens.superAdmin }))).status, 200);
    for (const [label, token] of NON_ADMIN()) assert.equal((await statusRoute(req('GET', '/sync/status', { token }))).status, 403, label);
    assert.equal((await statusRoute(req('GET', '/sync/status'))).status, 401);
  });

  it('only Super Admin can write: Office Head, Office Staff and Executive get 403', async () => {
    for (const [label, token] of NON_ADMIN()) {
      const writes = [
        putSchedule(req('PUT', '/schedule', { token, body: { days: CHARTER_DAYS } })),
        postException(req('POST', '/exceptions', { token, body: entry('2041-01-01') })),
        putException(req('PUT', `/exceptions/${randomUUID()}`, { token, body: entry('2041-01-02') }), ctx(randomUUID())),
        deleteException(req('DELETE', `/exceptions/${randomUUID()}`, { token }), ctx(randomUUID())),
        postTerm(req('POST', '/terms', { token, body: { term_name: 'X', start_date: '2041-01-01', end_date: '2041-02-01' } })),
        putTerm(req('PUT', `/terms/${randomUUID()}`, { token, body: { term_name: 'X', start_date: '2041-01-01', end_date: '2041-02-01' } }), ctx(randomUUID())),
      ];
      for (const response of await Promise.all(writes)) assert.equal(response.status, 403, label);
    }
    const ok = await putSchedule(req('PUT', '/schedule', { token: tokens.superAdmin, body: { days: CHARTER_DAYS } }));
    assert.equal(ok.status, 200);
    const created = await postException(req('POST', '/exceptions', { token: tokens.superAdmin, body: entry('2041-01-01') }));
    assert.equal(created.status, 201);
  });

  it('exceptions for Office Head / Office Staff stay campus-wide plus their own office; other roles see all', async () => {
    const add = async (body) => assert.equal((await postException(req('POST', '/exceptions', { token: tokens.superAdmin, body }))).status, 201);
    await add({ exception_date: '2042-03-03', exception_type: 'REGULAR_HOLIDAY', description: 'Campus wide' });
    await add(entry('2042-03-04', { office_id: OFFICE_A, description: 'Office A only' }));
    await add(entry('2042-03-05', { office_id: OFFICE_B, description: 'Office B only' }));
    const descriptions = async (token) =>
      (await (await listExceptions(req('GET', '/exceptions?from=2042-03-01&to=2042-03-31', { token }))).json()).items.map((e) => e.description).sort();
    for (const token of [tokens.officeHeadA, tokens.officeStaffA]) {
      assert.deepEqual(await descriptions(token), ['Campus wide', 'Office A only']);
    }
    for (const token of [tokens.superAdmin, tokens.executive]) {
      assert.deepEqual(await descriptions(token), ['Campus wide', 'Office A only', 'Office B only']);
    }
    const other = await listExceptions(req('GET', `/exceptions?office_id=${OFFICE_B}`, { token: tokens.officeStaffA }));
    assert.equal(other.status, 403);
  });
});
