// EB7: machine keys (issue, expiry, rotation with overlap, instant revocation, no secrets stored or logged).
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { GET as declarationsRoute } from '../src/app/api/declarations/route.js';
import { GET as listRoute, POST as issueRoute } from '../src/app/api/machine-keys/route.js';
import { POST as rotateRoute } from '../src/app/api/machine-keys/[id]/rotate/route.js';
import { POST as revokeRoute } from '../src/app/api/machine-keys/[id]/revoke/route.js';
import { ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => { env = await setupTestEnv(); });
after(async () => env?.teardown());

const RANGE = '/declarations?from=2026-08-17&to=2026-12-12';
const issue = async (body = { caller: 'FMS', environment: 'test' }, token = tokens.superAdmin) => {
  const response = await issueRoute(req('POST', '/machine-keys', { token, body }));
  return { response, body: await response.json() };
};
const rotate = async (id, body) => {
  const response = await rotateRoute(req('POST', `/machine-keys/${id}/rotate`, { token: tokens.superAdmin, body }), ctx(id));
  return { response, body: await response.json() };
};
const revoke = (id) => revokeRoute(req('POST', `/machine-keys/${id}/revoke`, { token: tokens.superAdmin }), ctx(id));
const pullWith = async (key) => (await declarationsRoute(req('GET', RANGE, { token: key }))).status;
const reset = () => env.ds.query('DELETE FROM machine_keys');

describe('EB7 machine keys', () => {
  it('only a Super Admin can issue, list, rotate or revoke', async () => {
    await reset();
    assert.equal((await issue(undefined, tokens.executive)).response.status, 403);
    assert.equal((await issueRoute(req('POST', '/machine-keys', { body: { caller: 'FMS', environment: 'test' } }))).status, 401);
    assert.equal((await listRoute(req('GET', '/machine-keys', { token: tokens.officeHeadA }))).status, 403);
  });

  it('AC1: a valid key gets 200 on the pull route; the reply shows the key once and the list never shows it', async () => {
    await reset();
    const { response, body } = await issue();
    assert.equal(response.status, 201);
    assert.match(body.key, /^ccms_mk_[0-9a-f]{12}\./);
    assert.equal(body.machine_key.status, 'ACTIVE');
    assert.equal(await pullWith(body.key), 200);
    const list = await (await listRoute(req('GET', '/machine-keys', { token: tokens.superAdmin }))).json();
    assert.equal(list.items.length, 1);
    assert.equal(JSON.stringify(list).includes(body.key.split('.')[1]), false);
  });

  it('the database holds a hash, not the secret, and the audit event carries no secret', async () => {
    await reset();
    const { body } = await issue();
    const secret = body.key.split('.')[1];
    const [row] = await env.ds.query('SELECT key_hash FROM machine_keys');
    assert.notEqual(row.key_hash, secret);
    assert.equal(row.key_hash.length, 64);
    const events = await env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = 'MACHINE_KEY_ISSUED'`);
    assert.ok(events.length >= 1);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes(row.key_hash), false);
  });

  it('expires 90 days after issue', async () => {
    await reset();
    const { body } = await issue();
    const [row] = await env.ds.query(`SELECT (expires_at - issued_at) = interval '90 days' AS ok FROM machine_keys`);
    assert.equal(row.ok, true);
    assert.ok(body.machine_key.expires_at > body.machine_key.issued_at);
  });

  it('AC2: an expired key gets 401', async () => {
    await reset();
    const { body } = await issue();
    await env.ds.query(`UPDATE machine_keys SET expires_at = now() - interval '1 second'`);
    assert.equal(await pullWith(body.key), 401);
  });

  it('AC3: during rotation both keys work; after the overlap only the new one', async () => {
    await reset();
    const first = (await issue()).body;
    const { response, body: second } = await rotate(first.machine_key.key_id, {});
    assert.equal(response.status, 201);
    assert.notEqual(second.key, first.key);
    assert.equal(await pullWith(first.key), 200);
    assert.equal(await pullWith(second.key), 200);
    const [old] = await env.ds.query('SELECT expires_at < now() + interval \'7 days 1 minute\' AS within FROM machine_keys WHERE key_id = $1', [first.machine_key.key_id]);
    assert.equal(old.within, true);
    await env.ds.query(`UPDATE machine_keys SET expires_at = now() - interval '1 second' WHERE key_id = $1`, [first.machine_key.key_id]);
    assert.equal(await pullWith(first.key), 401);
    assert.equal(await pullWith(second.key), 200);
  });

  it('the overlap can be 0 to 7 days and nothing else', async () => {
    await reset();
    const first = (await issue()).body;
    assert.equal((await rotate(first.machine_key.key_id, { overlap_days: 8 })).response.status, 400);
    assert.equal((await rotate(first.machine_key.key_id, { overlap_days: -1 })).response.status, 400);
    const { response } = await rotate(first.machine_key.key_id, { overlap_days: 0 });
    assert.equal(response.status, 201);
    assert.equal(await pullWith(first.key), 401);
  });

  it('a key that was already rotated cannot be rotated again', async () => {
    await reset();
    const first = (await issue()).body;
    await rotate(first.machine_key.key_id, {});
    assert.equal((await rotate(first.machine_key.key_id, {})).response.status, 409);
  });

  it('AC4: a revoked key is refused at once, and revoking twice is a 409', async () => {
    await reset();
    const { body } = await issue();
    assert.equal(await pullWith(body.key), 200);
    assert.equal((await revoke(body.machine_key.key_id)).status, 200);
    assert.equal(await pullWith(body.key), 401);
    assert.equal((await revoke(body.machine_key.key_id)).status, 409);
  });

  it('one active key per caller and environment; a different caller or environment is separate', async () => {
    await reset();
    assert.equal((await issue()).response.status, 201);
    assert.equal((await issue()).response.status, 409);
    assert.equal((await issue({ caller: 'SMS', environment: 'test' })).response.status, 201);
    assert.equal((await issue({ caller: 'FMS', environment: 'staging' })).response.status, 201);
  });

  it('refuses a bad caller, environment or scope under the field', async () => {
    await reset();
    for (const [body, field] of [
      [{ caller: 'X', environment: 'test' }, 'caller'],
      [{ caller: 'FMS', environment: 'prod' }, 'environment'],
      [{ caller: 'FMS', environment: 'test', scope: 'write-all' }, 'scope'],
    ]) {
      const { response, body: error } = await issue(body);
      assert.equal(response.status, 400);
      assert.ok(JSON.stringify(error).includes(field));
    }
  });

  it('a wrong secret with a real ref, a user token and a malformed header are all 401', async () => {
    await reset();
    const { body } = await issue();
    const ref = body.key.split('.')[0];
    assert.equal(await pullWith(`${ref}.${'x'.repeat(43)}`), 401);
    assert.equal(await pullWith(tokens.superAdmin), 401);
    assert.equal(await pullWith(''), 401);
  });
});
