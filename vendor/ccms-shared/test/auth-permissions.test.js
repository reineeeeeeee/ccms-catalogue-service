import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { SignJWT, generateKeyPair } from 'jose';
import { AppError, ROLES, errorResponse, officeFilter, requirePermission, route } from '../src/index.js';
import { createTestKeys, jsonRequest } from '../src/testing/index.js';

const OFFICE_A = '11111111-1111-4111-8111-111111111111';
const OFFICE_B = '22222222-2222-4222-8222-222222222222';

let keys;
before(async () => {
  keys = await createTestKeys();
});

async function call(check, { method = 'GET', token, target } = {}) {
  const request = jsonRequest('http://localhost/x', { method, token });
  try {
    return { user: await check(request, target) };
  } catch (err) {
    assert.ok(err instanceof AppError, `unexpected error: ${err?.stack}`);
    return { error: err };
  }
}

describe('token verification (TT4 AC1, AC2)', () => {
  const check = () => (request, target) =>
    requirePermission(Object.values(ROLES), 'campus', { verifier: keys.verifier })(request, target);

  it('gives the route the caller role and office', async () => {
    const token = await keys.signToken({ role: ROLES.OFFICE_STAFF, office_id: OFFICE_A, full_name: 'Ana Cruz' });
    const { user } = await call(check(), { token });
    assert.equal(user.role, ROLES.OFFICE_STAFF);
    assert.equal(user.officeId, OFFICE_A);
    assert.equal(user.fullName, 'Ana Cruz');
  });

  it('returns 401 for a missing token', async () => {
    const { error } = await call(check());
    assert.equal(error.status, 401);
  });

  it('returns 401 for an expired token', async () => {
    const token = await keys.signToken({ role: ROLES.SUPER_ADMIN, exp: Math.floor(Date.now() / 1000) - 60 });
    const { error } = await call(check(), { token });
    assert.equal(error.status, 401);
  });

  it('returns 401 for a tampered token', async () => {
    const token = await keys.signToken({ role: ROLES.OFFICE_STAFF, office_id: OFFICE_A });
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: ROLES.SUPER_ADMIN })).toString('base64url');
    const { error } = await call(check(), { token: `${h}.${forged}.${s}` });
    assert.equal(error.status, 401);
  });

  it('returns 401 for a token signed with another key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ role: ROLES.SUPER_ADMIN })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('x')
      .setIssuer(keys.issuer)
      .setAudience(keys.audience)
      .setExpirationTime('5m')
      .sign(privateKey);
    const { error } = await call(check(), { token });
    assert.equal(error.status, 401);
  });

  it('returns 401 for the wrong issuer or audience, and for an unknown role', async () => {
    const other = await createTestKeys({ issuer: 'someone-else' });
    const wrongIssuer = await other.signToken({ role: ROLES.SUPER_ADMIN });
    assert.equal((await call(check(), { token: wrongIssuer })).error.status, 401);

    const unknownRole = await keys.signToken({ role: 'citizen' });
    assert.equal((await call(check(), { token: unknownRole })).error.status, 401);
  });
});

describe('standard error format (TT4 AC2, AC4)', () => {
  it('returns { error: { code, message, details, correlation_id, timestamp } } and no stack trace', async () => {
    const handler = route(async () => {
      const check = requirePermission([ROLES.SUPER_ADMIN], 'campus', { verifier: keys.verifier });
      await check(jsonRequest('http://localhost/x'));
      return new Response('ok');
    });
    const response = await handler(jsonRequest('http://localhost/x', { headers: { 'x-correlation-id': 'corr-12345678' } }));
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'correlation_id', 'details', 'message', 'timestamp']);
    assert.equal(body.error.correlation_id, 'corr-12345678');
    assert.equal(response.headers.get('x-correlation-id'), 'corr-12345678');
    assert.ok(!JSON.stringify(body).includes('at '), 'body must not contain a stack trace');
  });

  it('hides internals of unexpected errors', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const handler = route(async () => {
        throw new Error('database password is hunter2');
      });
      const response = await handler(jsonRequest('http://localhost/x'));
      const text = await response.text();
      assert.equal(response.status, 500);
      assert.ok(!text.includes('hunter2'));
      assert.ok(!text.includes('stack'));
      assert.equal(JSON.parse(text).error.code, 'INTERNAL_ERROR');
    } finally {
      console.error = original;
    }
  });

  it('generates a correlation id when the caller sends none, and rejects unsafe ones', async () => {
    const response = errorResponse(new AppError(404, 'NOT_FOUND', 'Nope'), 'abc-123-xyz');
    assert.equal((await response.json()).error.correlation_id, 'abc-123-xyz');
    const handler = route(async () => new Response('ok'));
    const res = await handler(jsonRequest('http://localhost/x', { headers: { 'x-correlation-id': 'bad id with spaces' } }));
    assert.match(res.headers.get('x-correlation-id'), /^[0-9a-f-]{36}$/);
  });
});

describe('requirePermission (CC004)', () => {
  // Built lazily: `keys` is created in the before() hook, after describe() bodies run.
  const office = (request, target) =>
    requirePermission([ROLES.SUPER_ADMIN, ROLES.OFFICE_HEAD, ROLES.OFFICE_STAFF, ROLES.EXECUTIVE], 'office', {
      verifier: keys.verifier,
    })(request, target);

  it('limits Office Head and Office Staff to their own office', async () => {
    for (const role of [ROLES.OFFICE_HEAD, ROLES.OFFICE_STAFF]) {
      const token = await keys.signToken({ role, office_id: OFFICE_A });
      assert.ok((await call(office, { token, target: { officeId: OFFICE_A } })).user);
      assert.equal((await call(office, { token, target: { officeId: OFFICE_B } })).error.status, 403);
      assert.equal((await call(office, { token, target: { officeId: null } })).error.status, 403);
    }
  });

  it('lets Super Admin reach any office and Executive read anywhere', async () => {
    const admin = await keys.signToken({ role: ROLES.SUPER_ADMIN });
    const exec = await keys.signToken({ role: ROLES.EXECUTIVE });
    for (const officeId of [OFFICE_A, OFFICE_B]) {
      assert.ok((await call(office, { token: admin, method: 'POST', target: { officeId } })).user);
      assert.ok((await call(office, { token: exec, target: { officeId } })).user);
    }
  });

  it('makes Executive read-only on every write method', async () => {
    const exec = await keys.signToken({ role: ROLES.EXECUTIVE });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await call(office, { token: exec, method })).error.status, 403);
    }
  });

  it('rejects roles that are not in the route role list', async () => {
    const onlyAdmin = requirePermission([ROLES.SUPER_ADMIN], 'campus', { verifier: keys.verifier });
    const token = await keys.signToken({ role: ROLES.OFFICE_HEAD, office_id: OFFICE_A });
    assert.equal((await call(onlyAdmin, { token })).error.status, 403);
  });

  it('officeFilter limits office-bound callers only', () => {
    assert.equal(officeFilter({ role: ROLES.OFFICE_STAFF, officeId: OFFICE_A }), OFFICE_A);
    assert.equal(officeFilter({ role: ROLES.EXECUTIVE, officeId: null }), null);
    assert.equal(officeFilter({ role: ROLES.SUPER_ADMIN, officeId: null }), null);
  });
});
