import { randomUUID } from 'node:crypto';
import { ROLES, Errors, assertOfficeAccess, isUniqueViolation, recordAudit } from 'ccms-shared';
import {
  PAST_STANDARD,
  STANDARD_DATE_TAKEN,
  addDays,
  manilaToday,
  parseStandardFields,
  throwIfInvalid,
} from './catalogue-rules.js';
import { ServiceStandard } from '../entities/index.js';
import { kickOutbox } from '../outbox.js';

export const STANDARD_COLUMNS = `standard_id, service_id, version_no, duration_days, duration_hours, duration_minutes,
  effective_from::text AS effective_from, effective_to::text AS effective_to, charter_reference, created_at`;

export function toStandardDto(row) {
  return {
    standard_id: row.standard_id,
    service_id: row.service_id,
    version_no: row.version_no,
    duration_days: row.duration_days,
    duration_hours: row.duration_hours,
    duration_minutes: row.duration_minutes,
    effective_from: row.effective_from,
    effective_to: row.effective_to ?? null,
    charter_reference: row.charter_reference,
    created_at: row.created_at,
  };
}

/** Every version of a service, newest first. */
export async function listStandardRows(manager, serviceId) {
  return manager.query(
    `SELECT ${STANDARD_COLUMNS} FROM service_standards WHERE service_id = $1 ORDER BY effective_from DESC`,
    [serviceId],
  );
}

async function loadStandard(manager, standardId) {
  const rows = await manager.query(`SELECT ${STANDARD_COLUMNS} FROM service_standards WHERE standard_id = $1`, [standardId]);
  return rows[0] ? toStandardDto(rows[0]) : null;
}

/** Locks the service row for the rest of the transaction so version changes do not race. */
async function lockService(manager, serviceId) {
  const rows = await manager.query('SELECT service_id, office_id FROM services WHERE service_id = $1 FOR UPDATE', [serviceId]);
  if (!rows[0]) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  return rows[0];
}

function audit(manager, actor, action, service, before, after, ipAddress) {
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'ServiceStandard',
    entityId: (after ?? before).standard_id,
    officeId: service.office_id,
    before,
    after,
    ipAddress,
  });
}

/** Version 1 of a brand-new service. It may start on any chosen date (no "not in the past" rule). */
export async function insertFirstStandard(manager, actor, service, fields, ipAddress) {
  const standardId = randomUUID();
  await manager.getRepository(ServiceStandard).insert({
    standardId,
    serviceId: service.service_id,
    versionNo: 1,
    durationDays: fields.durationDays,
    durationHours: fields.durationHours,
    durationMinutes: fields.durationMinutes,
    effectiveFrom: fields.effectiveFrom,
    effectiveTo: null,
    charterReference: fields.charterReference,
  });
  const dto = await loadStandard(manager, standardId);
  await audit(manager, actor, 'STANDARD_VERSION_CREATED', service, null, dto, ipAddress);
  return dto;
}

/** A new version from effective_from; the previous version ends the day before. Caller holds the service lock. */
async function addVersionLocked(manager, actor, service, fields, ipAddress) {
  const rows = await listStandardRows(manager, service.service_id);
  if (rows.some((r) => r.effective_from === fields.effectiveFrom)) {
    throw Errors.conflict(STANDARD_DATE_TAKEN, 'STANDARD_DATE_EXISTS', { effective_from: STANDARD_DATE_TAKEN });
  }
  if (fields.effectiveFrom < manilaToday()) {
    throw Errors.validation(PAST_STANDARD, { effective_from: PAST_STANDARD });
  }
  const latest = rows[0]; // newest first
  if (latest && fields.effectiveFrom < latest.effective_from) {
    const message = `A newer version already starts on ${latest.effective_from}; delete it first or choose a later date`;
    throw Errors.conflict(message, 'STANDARD_NOT_LATEST', { effective_from: message });
  }

  let closed = null;
  if (latest) {
    const effectiveTo = addDays(fields.effectiveFrom, -1);
    await manager.getRepository(ServiceStandard).update({ standardId: latest.standard_id }, { effectiveTo });
    closed = { standard_id: latest.standard_id, version_no: latest.version_no, effective_to_before: latest.effective_to ?? null, effective_to_after: effectiveTo };
  }
  const standardId = randomUUID();
  await manager.getRepository(ServiceStandard).insert({
    standardId,
    serviceId: service.service_id,
    versionNo: rows.reduce((max, r) => Math.max(max, r.version_no), 0) + 1,
    durationDays: fields.durationDays,
    durationHours: fields.durationHours,
    durationMinutes: fields.durationMinutes,
    effectiveFrom: fields.effectiveFrom,
    effectiveTo: null,
    charterReference: fields.charterReference,
  });
  const dto = await loadStandard(manager, standardId);
  await audit(manager, actor, 'STANDARD_VERSION_CREATED', service, null, closed ? { ...dto, closed_previous_version: closed } : dto, ipAddress);
  return dto;
}

export async function createStandard(dataSource, actor, serviceId, body, { ipAddress } = {}) {
  const details = {};
  const fields = parseStandardFields(body, details);
  throwIfInvalid(details);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const service = await lockService(manager, serviceId);
      return addVersionLocked(manager, actor, service, fields, ipAddress);
    });
    kickOutbox();
    return dto;
  } catch (err) {
    if (isUniqueViolation(err, 'service_standards_')) {
      throw Errors.conflict(STANDARD_DATE_TAKEN, 'STANDARD_DATE_EXISTS', { effective_from: STANDARD_DATE_TAKEN });
    }
    throw err;
  }
}

/** Only a version that has not started yet can be deleted; the version before it is reopened. */
export async function deleteStandard(dataSource, actor, serviceId, standardId, { ipAddress } = {}) {
  await dataSource.transaction(async (manager) => {
    const service = await lockService(manager, serviceId);
    const rows = await listStandardRows(manager, serviceId); // newest first
    const index = rows.findIndex((r) => r.standard_id === standardId);
    if (index < 0) throw Errors.notFound('Standard not found', 'STANDARD_NOT_FOUND');
    const target = rows[index];
    if (target.effective_from <= manilaToday()) {
      throw Errors.conflict('A standard that is already in effect cannot be deleted', 'STANDARD_IN_EFFECT');
    }
    if (rows.length === 1) throw Errors.conflict('A service must keep at least one standard', 'STANDARD_LAST_VERSION');
    const before = toStandardDto(target);
    await manager.getRepository(ServiceStandard).delete({ standardId });

    const next = rows[index - 1]; // the version that starts after the deleted one
    const previous = rows[index + 1];
    let reopened = null;
    if (previous) {
      const effectiveTo = next ? addDays(next.effective_from, -1) : null;
      await manager.getRepository(ServiceStandard).update({ standardId: previous.standard_id }, { effectiveTo });
      reopened = { standard_id: previous.standard_id, version_no: previous.version_no, effective_to_before: previous.effective_to ?? null, effective_to_after: effectiveTo };
    }
    await audit(manager, actor, 'STANDARD_VERSION_DELETED', service, reopened ? { ...before, reopened_previous_version: reopened } : before, null, ipAddress);
  });
  kickOutbox();
}

/** History for a service. Non-Super-Admin callers get 404 for an inactive service; another office => 403 for Office Head / Office Staff. */
export async function listStandards(dataSource, user, serviceId) {
  const services = await dataSource.query('SELECT is_active, office_id FROM services WHERE service_id = $1', [serviceId]);
  if (!services[0] || (user.role !== ROLES.SUPER_ADMIN && !services[0].is_active)) {
    throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  }
  assertOfficeAccess(user, services[0].office_id);
  return (await listStandardRows(dataSource, serviceId)).map(toStandardDto);
}

/**
 * The as-of lookup used by Transaction: the version whose range contains the Manila date.
 * `viewer` is a user, or null for a trusted service call (any office). Office Head / Office Staff
 * get 403 for another office's service. Inactive service => 409.
 */
export async function getStandardAsOf(dataSource, serviceId, asOf, viewer = null) {
  const rows = await dataSource.query(
    `SELECT s.service_id, s.office_id, s.service_code, s.service_name, s.is_active,
            st.standard_id, st.duration_days, st.duration_hours, st.duration_minutes
       FROM services s
       LEFT JOIN service_standards st
         ON st.service_id = s.service_id
        AND st.effective_from <= $2::date
        AND (st.effective_to IS NULL OR st.effective_to >= $2::date)
      WHERE s.service_id = $1
      ORDER BY st.effective_from DESC
      LIMIT 1`,
    [serviceId, asOf],
  );
  const row = rows[0];
  if (!row) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  if (viewer) assertOfficeAccess(viewer, row.office_id);
  if (!row.is_active) throw Errors.conflict('Service inactive', 'SERVICE_INACTIVE');
  if (!row.standard_id) throw Errors.notFound(`No standard is in force for this service on ${asOf}`, 'STANDARD_NOT_FOUND');
  return {
    standard_id: row.standard_id,
    duration_days: row.duration_days,
    duration_hours: row.duration_hours,
    duration_minutes: row.duration_minutes,
    service_code: row.service_code,
    service_name: row.service_name,
    office_id: row.office_id,
  };
}
