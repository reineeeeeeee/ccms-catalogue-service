import { randomUUID } from 'node:crypto';
import { ROLES, Errors, isUniqueViolation, recordAudit } from 'ccms-shared';
import { Office } from '../entities/index.js';
import { kickOutbox } from '../outbox.js';

export const CODE_TAKEN = 'Office code already exists';
export const NAME_TAKEN = 'Office name already exists';

export function toOfficeDto(office) {
  return {
    office_id: office.officeId,
    office_code: office.officeCode,
    office_name: office.officeName,
    is_active: office.isActive,
    created_at: office.createdAt,
    updated_at: office.updatedAt,
  };
}

/**
 * office_code: required, trimmed, unique (case-insensitive, checked on save).
 * office_name: required, kept exactly as the Charter wording (only surrounding spaces trimmed),
 *   unique ignoring letter case and extra spaces, even when the code is different.
 */
export function parseOfficeInput(body) {
  const details = {};
  const officeCode = typeof body.office_code === 'string' ? body.office_code.trim() : '';
  const officeName = typeof body.office_name === 'string' ? body.office_name.trim() : '';
  if (!officeCode) details.office_code = 'Office code is required';
  else if (officeCode.length > 20) details.office_code = 'Office code must be 20 characters or fewer';
  if (!officeName) details.office_name = 'Office name is required';
  else if (officeName.length > 200) details.office_name = 'Office name must be 200 characters or fewer';
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return { officeCode, officeName };
}

async function codeTaken(manager, code, exceptId = null) {
  const rows = await manager.query(
    'SELECT 1 FROM offices WHERE lower(office_code) = lower($1) AND ($2::uuid IS NULL OR office_id <> $2::uuid) LIMIT 1',
    [code, exceptId],
  );
  return rows.length > 0;
}

// Same name = same words ignoring letter case and extra spaces ("OSAS", "osas" and " Osas " are one name).
async function nameTaken(manager, name, exceptId = null) {
  const rows = await manager.query(
    `SELECT 1 FROM offices
      WHERE lower(regexp_replace(btrim(office_name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))
        AND ($2::uuid IS NULL OR office_id <> $2::uuid)
      LIMIT 1`,
    [name, exceptId],
  );
  return rows.length > 0;
}

/** Code and name must both be free. Reports every clash at once, each under its own field. */
async function assertUnique(manager, officeCode, officeName, exceptId = null) {
  const details = {};
  if (await codeTaken(manager, officeCode, exceptId)) details.office_code = CODE_TAKEN;
  if (await nameTaken(manager, officeName, exceptId)) details.office_name = NAME_TAKEN;
  if (Object.keys(details).length) {
    throw Errors.conflict(details.office_code ?? details.office_name, details.office_code ? 'OFFICE_CODE_EXISTS' : 'OFFICE_NAME_EXISTS', details);
  }
}

function audit(manager, actor, action, before, after, ipAddress) {
  const office = after ?? before;
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'office',
    entityId: office.office_id,
    officeId: office.office_id,
    before,
    after,
    ipAddress,
  });
}

async function findOrFail(manager, id) {
  const office = await manager.getRepository(Office).findOneBy({ officeId: id });
  if (!office) throw Errors.notFound('Office not found', 'OFFICE_NOT_FOUND');
  return office;
}

export async function createOffice(dataSource, actor, input, { ipAddress } = {}) {
  const { officeCode, officeName } = parseOfficeInput(input);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      await assertUnique(manager, officeCode, officeName);
      const saved = await manager
        .getRepository(Office)
        .save({ officeId: randomUUID(), officeCode, officeName, isActive: true });
      const created = toOfficeDto(await findOrFail(manager, saved.officeId));
      await audit(manager, actor, 'OFFICE_CREATED', null, created, ipAddress);
      return created;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    if (isUniqueViolation(err, 'offices_code_lower_uq')) throw Errors.conflict(CODE_TAKEN, 'OFFICE_CODE_EXISTS');
    throw err;
  }
}

export async function updateOffice(dataSource, actor, id, input, { ipAddress } = {}) {
  const { officeCode, officeName } = parseOfficeInput(input);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const existing = await findOrFail(manager, id);
      const before = toOfficeDto(existing);
      if (before.office_code === officeCode && before.office_name === officeName) return before;
      await assertUnique(manager, officeCode, officeName, id);
      await manager.getRepository(Office).update({ officeId: id }, { officeCode, officeName });
      const after = toOfficeDto(await findOrFail(manager, id));
      await audit(manager, actor, 'OFFICE_UPDATED', before, after, ipAddress);
      return after;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    if (isUniqueViolation(err, 'offices_code_lower_uq')) throw Errors.conflict(CODE_TAKEN, 'OFFICE_CODE_EXISTS');
    throw err;
  }
}

/** Deactivate or reactivate. Doing it twice is a no-op (no second audit entry). */
export async function setOfficeActive(dataSource, actor, id, isActive, { ipAddress } = {}) {
  const dto = await dataSource.transaction(async (manager) => {
    const existing = await findOrFail(manager, id);
    const before = toOfficeDto(existing);
    if (existing.isActive === isActive) return before;
    await manager.getRepository(Office).update({ officeId: id }, { isActive });
    const after = toOfficeDto(await findOrFail(manager, id));
    await audit(manager, actor, isActive ? 'OFFICE_REACTIVATED' : 'OFFICE_DEACTIVATED', before, after, ipAddress);
    return after;
  });
  kickOutbox();
  return dto;
}

/** Any signed-in user sees active offices; Super Admin also sees inactive ones. */
export async function listOffices(dataSource, user, { q } = {}) {
  const qb = dataSource.getRepository(Office).createQueryBuilder('o').orderBy('lower(o.officeCode)', 'ASC');
  if (user.role !== ROLES.SUPER_ADMIN) qb.andWhere('o.isActive = true');
  if (q?.trim()) {
    qb.andWhere('(o.officeCode ILIKE :q OR o.officeName ILIKE :q)', { q: `%${q.trim().replace(/[%_\\]/g, '\\$&')}%` });
  }
  return (await qb.getMany()).map(toOfficeDto);
}

/**
 * One office. `viewer` is a user for browser calls, or null for a trusted service call (Identity's
 * account office check), which also sees inactive offices so it can reject them itself.
 */
export async function getOffice(dataSource, id, viewer) {
  const office = await dataSource.getRepository(Office).findOneBy({ officeId: id });
  if (!office || (viewer && viewer.role !== ROLES.SUPER_ADMIN && !office.isActive)) {
    throw Errors.notFound('Office not found', 'OFFICE_NOT_FOUND');
  }
  return toOfficeDto(office);
}
