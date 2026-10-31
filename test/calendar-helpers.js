// Shared test setup (not a test file): database, tokens, request helpers.
import { randomUUID } from 'node:crypto';
import { ROLES, setDataSource, setDefaultVerifier } from 'ccms-shared';
import { createTestDatabase, createTestKeys } from 'ccms-shared/testing';
import { afterSync } from '../src/lib/after-sync.js';
import { entities } from '../src/lib/entities/index.js';

export const SERVICE_KEY = 'test-service-key-0123456789';
export const OFFICE_A = randomUUID();
export const OFFICE_B = randomUUID();

// Declared up front (null) so runBoundarySuite can be given the object before before() fills it in.
export const tokens = { superAdmin: null, executive: null, officeHeadA: null, officeStaffA: null };

export async function setupTestEnv() {
  process.env.SERVICE_KEY = SERVICE_KEY;
  const keys = await createTestKeys();
  setDefaultVerifier(keys.verifier);
  const testDb = await createTestDatabase({ entities, afterSync });
  setDataSource(testDb.dataSource);
  Object.assign(tokens, {
    superAdmin: await keys.signToken({ role: ROLES.SUPER_ADMIN, full_name: 'Sam Admin' }),
    executive: await keys.signToken({ role: ROLES.EXECUTIVE }),
    officeHeadA: await keys.signToken({ role: ROLES.OFFICE_HEAD, office_id: OFFICE_A }),
    officeStaffA: await keys.signToken({ role: ROLES.OFFICE_STAFF, office_id: OFFICE_A }),
  });
  return {
    ds: testDb.dataSource,
    tokens,
    async teardown() {
      setDataSource(null);
      await testDb.drop();
    },
  };
}

export const req = (method, path, { token, body, headers, key } = {}) =>
  new Request(`http://localhost/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-service-key': key } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

export const ctx = (id) => ({ params: Promise.resolve({ id }) });

export const day = (day_of_week, is_working, opening_time = null, closing_time = null) => ({
  day_of_week,
  is_working,
  opening_time: is_working ? opening_time : null,
  closing_time: is_working ? closing_time : null,
});

// CC014 AC1: Tue-Fri 08:00-19:00, Sat 08:00-17:00, Sun and Mon non-working.
export const CHARTER_DAYS = [
  day(0, false),
  day(1, false),
  day(2, true, '08:00', '19:00'),
  day(3, true, '08:00', '19:00'),
  day(4, true, '08:00', '19:00'),
  day(5, true, '08:00', '19:00'),
  day(6, true, '08:00', '17:00'),
];

export const DEFAULT_DAYS = [
  day(0, false),
  day(1, true, '08:00', '17:00'),
  day(2, true, '08:00', '17:00'),
  day(3, true, '08:00', '17:00'),
  day(4, true, '08:00', '17:00'),
  day(5, true, '08:00', '17:00'),
  day(6, false),
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the check returns a truthy value (background work such as the sync dispatcher). */
export async function waitFor(check, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}
