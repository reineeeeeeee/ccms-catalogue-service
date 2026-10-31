import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Errors, recordAudit } from 'ccms-shared';
import { MachineKey } from './entities/index.js';
import { newId } from './calendar/calendar-rules.js';
import { kickOutbox } from './outbox.js';

// EB7: machine keys for systems that call CCMS (today: FMS pulling the calendar; later SMS). Our own keys, not Clerk
// (PM/developers still to decide, see docs/MACHINE-KEYS.md). Rules from the task:
//   one key per caller and environment, expires 90 days after issue, up to 7 days of overlap while rotating,
//   revoked at once, an expired or revoked key gets 401, keys never appear in code, logs or chat.
// Only a SHA-256 hash of the secret is stored (the secret is high-entropy random, so a plain hash is enough). The full
// key is shown once, in the reply that creates it. Audit events carry metadata only, never the key or its hash.

export const KEY_PREFIX = 'ccms_mk_';
export const CALLERS = Object.freeze(['FMS', 'SMS']);
export const ENVIRONMENTS = Object.freeze(['development', 'test', 'staging', 'production']);
export const SCOPES = Object.freeze(['read-calendar']);
export const KEY_LIFETIME_DAYS = 90;
export const MAX_OVERLAP_DAYS = 7;

const sha256 = (value) => createHash('sha256').update(value).digest();
const detail = (field, message) => Errors.validation(message, { [field]: message });

function oneOf(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw detail(field, `${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

/** Key shape: ccms_mk_<12 hex ref>.<secret>. The ref finds the row; the secret is checked against the stored hash. */
function generate() {
  const ref = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { ref, key: `${KEY_PREFIX}${ref}.${secret}`, hash: sha256(secret).toString('hex') };
}

/** Public view of a key: metadata only, never the key or the hash. */
export function toKeyDto(row) {
  const now = Date.now();
  const expires = new Date(row.expiresAt).getTime();
  let status = 'ACTIVE';
  if (row.revokedAt) status = 'REVOKED';
  else if (expires <= now) status = 'EXPIRED';
  return {
    key_id: row.keyId,
    key_ref: row.keyRef,
    caller: row.caller,
    environment: row.environment,
    scope: row.scope,
    status,
    issued_at: new Date(row.issuedAt).toISOString(),
    expires_at: new Date(row.expiresAt).toISOString(),
    revoked_at: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
    replaced_by: row.replacedBy ?? null,
  };
}

// Writes never use RETURNING: TypeORM's query() returns a different shape for UPDATE than for SELECT, so the row is read back.
const fetchKey = async (manager, keyId, { lock = false } = {}) => {
  const [row] = await manager.query(
    `SELECT key_id AS "keyId", key_ref AS "keyRef", caller, environment, scope, issued_at AS "issuedAt",
            expires_at AS "expiresAt", revoked_at AS "revokedAt", replaced_by AS "replacedBy"
       FROM machine_keys WHERE key_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [keyId],
  );
  return row ?? null;
};

const audit = (manager, actor, action, before, after, ipAddress) =>
  recordAudit(manager, { actor, action, entityType: 'machine_key', entityId: (after ?? before).key_id, before, after, ipAddress });

async function insertKey(manager, { caller, environment, scope, createdBy }) {
  const { ref, key, hash } = generate();
  const keyId = newId();
  await manager.query(
    `INSERT INTO machine_keys (key_id, key_ref, key_hash, caller, environment, scope, issued_at, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now() + make_interval(days => $7), $8)`,
    [keyId, ref, hash, caller, environment, scope, KEY_LIFETIME_DAYS, createdBy ?? null],
  );
  const row = await fetchKey(manager, keyId);
  return { key, dto: toKeyDto(row) };
}

/** Super Admin issues a key. A caller+environment can hold more than one active key only through rotation. */
export async function issueMachineKey(dataSource, actor, body, { ipAddress } = {}) {
  const caller = oneOf(body?.caller, CALLERS, 'caller');
  const environment = oneOf(body?.environment, ENVIRONMENTS, 'environment');
  const scope = body?.scope === undefined ? SCOPES[0] : oneOf(body.scope, SCOPES, 'scope');
  const result = await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(43436, 407)');
    const [active] = await manager.query(
      `SELECT key_id FROM machine_keys WHERE caller = $1 AND environment = $2 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
      [caller, environment],
    );
    if (active) throw Errors.conflict('This caller already has an active key in this environment: rotate it instead', 'MACHINE_KEY_EXISTS');
    const created = await insertKey(manager, { caller, environment, scope, createdBy: actor?.id });
    await audit(manager, actor, 'MACHINE_KEY_ISSUED', null, created.dto, ipAddress);
    return created;
  });
  kickOutbox();
  return { machine_key: result.dto, key: result.key };
}

/**
 * Rotation: a new key is issued and the old one keeps working for the overlap (0 to 7 days, default 7), but never longer
 * than its own expiry. After the overlap only the new key works.
 */
export async function rotateMachineKey(dataSource, actor, keyId, body, { ipAddress } = {}) {
  let overlapDays = MAX_OVERLAP_DAYS;
  if (body?.overlap_days !== undefined) {
    overlapDays = body.overlap_days;
    if (!Number.isInteger(overlapDays) || overlapDays < 0 || overlapDays > MAX_OVERLAP_DAYS) {
      throw detail('overlap_days', `overlap_days must be a whole number from 0 to ${MAX_OVERLAP_DAYS}`);
    }
  }
  const result = await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(43436, 407)');
    const old = await fetchKey(manager, keyId, { lock: true });
    if (!old) throw Errors.notFound('Machine key not found', 'MACHINE_KEY_NOT_FOUND');
    const before = toKeyDto(old);
    if (before.status !== 'ACTIVE' || old.replacedBy) {
      throw Errors.conflict('Only an active key that has not been rotated can be rotated', 'MACHINE_KEY_NOT_ROTATABLE');
    }
    const created = await insertKey(manager, { caller: old.caller, environment: old.environment, scope: old.scope, createdBy: actor?.id });
    await manager.query(
      `UPDATE machine_keys SET replaced_by = $2, expires_at = LEAST(expires_at, now() + make_interval(days => $3)) WHERE key_id = $1`,
      [keyId, created.dto.key_id, overlapDays],
    );
    const updated = await fetchKey(manager, keyId);
    const after = toKeyDto(updated);
    await audit(manager, actor, 'MACHINE_KEY_ROTATED', before, after, ipAddress);
    await audit(manager, actor, 'MACHINE_KEY_ISSUED', null, created.dto, ipAddress);
    return { created, old: after };
  });
  kickOutbox();
  return { machine_key: result.created.dto, key: result.created.key, previous_key: result.old };
}

/** Revocation takes effect on the next request: the check reads the row every time. */
export async function revokeMachineKey(dataSource, actor, keyId, { ipAddress } = {}) {
  const dto = await dataSource.transaction(async (manager) => {
    const old = await fetchKey(manager, keyId, { lock: true });
    if (!old) throw Errors.notFound('Machine key not found', 'MACHINE_KEY_NOT_FOUND');
    if (old.revokedAt) throw Errors.conflict('This key is already revoked', 'MACHINE_KEY_ALREADY_REVOKED');
    const before = toKeyDto(old);
    await manager.query('UPDATE machine_keys SET revoked_at = now() WHERE key_id = $1', [keyId]);
    const updated = await fetchKey(manager, keyId);
    const after = toKeyDto(updated);
    await audit(manager, actor, 'MACHINE_KEY_REVOKED', before, after, ipAddress);
    return after;
  });
  kickOutbox();
  return dto;
}

export async function listMachineKeys(dataSource) {
  const rows = await dataSource.getRepository(MachineKey).find();
  return rows.map(toKeyDto).sort((a, b) => b.issued_at.localeCompare(a.issued_at));
}

const unauthorized = () => Errors.unauthorized('A valid machine key is required', 'INVALID_MACHINE_KEY');

/**
 * Checks `Authorization: Bearer ccms_mk_...` for a key that is not expired, not revoked and has the scope. Every failure
 * returns the same 401, so a caller cannot tell a wrong key from an expired one. A signed-in user's token does not have
 * the key shape and is refused. When `caller` is given (FMS or SMS), a key issued to the other caller is refused with the
 * same 401.
 */
export async function requireMachineKey(request, dataSource, scope, caller) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (ccms_mk_([0-9a-f]{12})\.([A-Za-z0-9_-]{20,}))$/.exec(header);
  if (!match) throw unauthorized();
  const [, , ref, secret] = match;
  const [row] = await dataSource.query(
    `SELECT key_id AS "keyId", key_hash AS "keyHash", scope, caller FROM machine_keys
      WHERE key_ref = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [ref],
  );
  const stored = Buffer.from(row?.keyHash ?? '0'.repeat(64), 'hex');
  const matches = timingSafeEqual(sha256(secret), stored.length === 32 ? stored : Buffer.alloc(32));
  if (!row || !matches || row.scope !== scope || (caller !== undefined && row.caller !== caller)) throw unauthorized();
  return { keyId: row.keyId };
}
