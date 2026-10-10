import { randomUUID } from 'node:crypto';
import { ROLES, Errors, assertOfficeAccess, isOfficeBound, isUniqueViolation, isUuid, recordAudit } from 'ccms-shared';
import {
  CLASSIFICATIONS,
  CODE_TAKEN,
  NAME_TAKEN,
  OFFICE_INACTIVE,
  SERVICE_SCOPES,
  likePattern,
  manilaToday,
  nameKey,
  normaliseServiceCode,
  parsePaging,
  parseServiceFields,
  parseStandardFields,
  throwIfInvalid,
} from './catalogue-rules.js';
import { listDocumentRows, toDocumentDto } from './documents.js';
import { Service } from '../entities/index.js';
import { kickOutbox } from '../outbox.js';
import { insertFirstStandard, listStandardRows, toStandardDto } from './standards.js';

// One service row plus its office and the version in force today (Manila date).
const SERVICE_SELECT = `
  SELECT s.service_id, s.office_id, o.office_code, o.office_name, s.service_code, s.service_name,
         s.classification, s.service_scope, s.transaction_types, s.measurement_type, s.processing_steps, s.fees,
         s.who_may_avail, s.is_active,
         s.created_at, s.updated_at,
         cs.standard_id AS cs_standard_id, cs.version_no AS cs_version_no,
         cs.duration_days AS cs_duration_days, cs.duration_hours AS cs_duration_hours,
         cs.duration_minutes AS cs_duration_minutes, cs.effective_from::text AS cs_effective_from,
         cs.effective_to::text AS cs_effective_to, cs.charter_reference AS cs_charter_reference
    FROM services s
    JOIN offices o ON o.office_id = s.office_id
    LEFT JOIN service_standards cs
      ON cs.service_id = s.service_id
     AND cs.effective_from <= $1::date
     AND (cs.effective_to IS NULL OR cs.effective_to >= $1::date)`;

export function toServiceDto(row) {
  return {
    service_id: row.service_id,
    office_id: row.office_id,
    office_code: row.office_code,
    office_name: row.office_name,
    service_code: row.service_code,
    service_name: row.service_name,
    classification: row.classification,
    service_scope: row.service_scope,
    transaction_types: row.transaction_types,
    measurement_type: row.measurement_type,
    processing_steps: row.processing_steps ?? null,
    fees: row.fees ?? null,
    who_may_avail: row.who_may_avail ?? null,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    current_standard: row.cs_standard_id
      ? {
          standard_id: row.cs_standard_id,
          version_no: row.cs_version_no,
          duration_days: row.cs_duration_days,
          duration_hours: row.cs_duration_hours,
          duration_minutes: row.cs_duration_minutes,
          effective_from: row.cs_effective_from,
          effective_to: row.cs_effective_to ?? null,
          charter_reference: row.cs_charter_reference,
        }
      : null,
  };
}

async function loadServiceDto(manager, serviceId) {
  const rows = await manager.query(`${SERVICE_SELECT} WHERE s.service_id = $2`, [manilaToday(), serviceId]);
  return rows[0] ? toServiceDto(rows[0]) : null;
}

function audit(manager, actor, action, before, after, ipAddress) {
  const service = after ?? before;
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'Service',
    entityId: service.service_id,
    officeId: service.office_id,
    before,
    after,
    ipAddress,
  });
}

/** The office must exist and be active. */
async function requireActiveOffice(manager, officeId) {
  const rows = isUuid(officeId)
    ? await manager.query('SELECT office_id, office_code, is_active FROM offices WHERE office_id = $1', [officeId])
    : [];
  if (!rows[0] || !rows[0].is_active) throw Errors.validation(OFFICE_INACTIVE, { office_id: OFFICE_INACTIVE });
  return rows[0];
}

function checkCodeFormat(serviceCode, office) {
  const code = normaliseServiceCode(serviceCode, office.office_code);
  if (!code) {
    const message = `Service code must look like ${office.office_code.toUpperCase()}-ABC-001 (office code, abbreviation, three digits)`;
    throw Errors.validation(message, { service_code: message });
  }
  return code;
}

async function assertUnique(manager, { officeId, serviceCode, serviceNameKey }, exceptId = null) {
  const byName = await manager.query(
    'SELECT 1 FROM services WHERE office_id = $1 AND service_name_key = $2 AND ($3::uuid IS NULL OR service_id <> $3::uuid) LIMIT 1',
    [officeId, serviceNameKey, exceptId],
  );
  if (byName.length) throw Errors.conflict(NAME_TAKEN, 'SERVICE_NAME_EXISTS', { service_name: NAME_TAKEN });
  const byCode = await manager.query(
    'SELECT 1 FROM services WHERE lower(service_code) = lower($1) AND ($2::uuid IS NULL OR service_id <> $2::uuid) LIMIT 1',
    [serviceCode, exceptId],
  );
  if (byCode.length) throw Errors.conflict(CODE_TAKEN, 'SERVICE_CODE_EXISTS', { service_code: CODE_TAKEN });
}

function mapUniqueViolation(err) {
  if (isUniqueViolation(err, 'services_office_name_uq')) {
    return Errors.conflict(NAME_TAKEN, 'SERVICE_NAME_EXISTS', { service_name: NAME_TAKEN });
  }
  if (isUniqueViolation(err, 'services_code_lower_uq')) {
    return Errors.conflict(CODE_TAKEN, 'SERVICE_CODE_EXISTS', { service_code: CODE_TAKEN });
  }
  return null;
}

/** Service and its first standard in one transaction (version 1 may start on any chosen date). */
export async function createService(dataSource, actor, body, { ipAddress } = {}) {
  const details = {};
  const fields = parseServiceFields(body, details);
  let standardFields = null;
  if (body.standard === null || typeof body.standard !== 'object' || Array.isArray(body.standard)) {
    details.standard = 'First standard is required';
  } else {
    standardFields = parseStandardFields(body.standard, details, 'standard.');
  }
  throwIfInvalid(details);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const office = await requireActiveOffice(manager, fields.officeId);
      const serviceCode = checkCodeFormat(fields.serviceCode, office);
      const serviceNameKey = nameKey(fields.serviceName);
      await assertUnique(manager, { officeId: office.office_id, serviceCode, serviceNameKey });

      const serviceId = randomUUID();
      await manager.getRepository(Service).insert({
        serviceId,
        officeId: office.office_id,
        serviceCode,
        serviceName: fields.serviceName,
        serviceNameKey,
        classification: fields.classification,
        serviceScope: fields.serviceScope,
        transactionTypes: fields.transactionTypes,
        measurementType: 'TIMELINESS',
        processingSteps: fields.processingSteps ?? null,
        fees: fields.fees ?? null,
        whoMayAvail: fields.whoMayAvail ?? null,
        isActive: true,
      });
      const created = await loadServiceDto(manager, serviceId);
      await audit(manager, actor, 'SERVICE_CREATED', null, created, ipAddress);
      await insertFirstStandard(manager, actor, { service_id: serviceId, office_id: office.office_id }, standardFields, ipAddress);
      return loadServiceDto(manager, serviceId);
    });
    kickOutbox();
    return dto;
  } catch (err) {
    throw mapUniqueViolation(err) ?? err;
  }
}

/** Edits the service fields (never the standard), with the same rules as creation. */
export async function updateService(dataSource, actor, id, body, { ipAddress } = {}) {
  const details = {};
  const fields = parseServiceFields(body, details);
  throwIfInvalid(details);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const rows = await manager.query('SELECT service_id FROM services WHERE service_id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
      const before = await loadServiceDto(manager, id);

      // An unchanged office may be inactive; moving to another office needs an active one.
      const office =
        fields.officeId === before.office_id
          ? { office_id: before.office_id, office_code: before.office_code }
          : await requireActiveOffice(manager, fields.officeId);
      const serviceCode = checkCodeFormat(fields.serviceCode, office);
      const serviceNameKey = nameKey(fields.serviceName);
      const processingSteps = fields.processingSteps === undefined ? before.processing_steps : fields.processingSteps;
      const fees = fields.fees === undefined ? before.fees : fields.fees;
      const whoMayAvail = fields.whoMayAvail === undefined ? before.who_may_avail : fields.whoMayAvail;

      const unchanged =
        office.office_id === before.office_id &&
        serviceCode === before.service_code &&
        fields.serviceName === before.service_name &&
        fields.classification === before.classification &&
        fields.serviceScope === before.service_scope &&
        fields.transactionTypes.length === before.transaction_types.length &&
        fields.transactionTypes.every((type, index) => type === before.transaction_types[index]) &&
        processingSteps === before.processing_steps &&
        fees === before.fees &&
        whoMayAvail === before.who_may_avail;
      if (unchanged) return before;

      await assertUnique(manager, { officeId: office.office_id, serviceCode, serviceNameKey }, id);
      await manager.getRepository(Service).update(
        { serviceId: id },
        {
          officeId: office.office_id,
          serviceCode,
          serviceName: fields.serviceName,
          serviceNameKey,
          classification: fields.classification,
          serviceScope: fields.serviceScope,
          transactionTypes: fields.transactionTypes,
          processingSteps,
          fees,
          whoMayAvail,
        },
      );
      const after = await loadServiceDto(manager, id);
      await audit(manager, actor, 'SERVICE_UPDATED', before, after, ipAddress);
      return after;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    throw mapUniqueViolation(err) ?? err;
  }
}

/** Deactivate or reactivate. Doing it twice is a no-op (no second audit entry). */
export async function setServiceActive(dataSource, actor, id, isActive, { ipAddress } = {}) {
  const dto = await dataSource.transaction(async (manager) => {
    const rows = await manager.query('SELECT service_id FROM services WHERE service_id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
    const before = await loadServiceDto(manager, id);
    if (before.is_active === isActive) return before;
    await manager.getRepository(Service).update({ serviceId: id }, { isActive });
    const after = await loadServiceDto(manager, id);
    await audit(manager, actor, isActive ? 'SERVICE_REACTIVATED' : 'SERVICE_DEACTIVATED', before, after, ipAddress);
    return after;
  });
  kickOutbox();
  return dto;
}

/**
 * Catalogue browse. Filters: office_id, classification, status (active|inactive|all), search over
 * service name / code / office name. Only Super Admin can see inactive services. Office Head / Office Staff are limited to their own office.
 */
export async function listServices(dataSource, user, params) {
  const { page, pageSize } = parsePaging(params);
  const details = {};
  const officeId = params.get('office_id');
  const classification = params.get('classification');
  const serviceScope = params.get('service_scope');
  const status = params.get('status') || 'active';
  const search = params.get('search')?.trim();
  if (officeId && !isUuid(officeId)) details.office_id = 'office_id must be a valid id';
  if (classification && !CLASSIFICATIONS.includes(classification)) {
    details.classification = `Classification must be one of ${CLASSIFICATIONS.join(', ')}`;
  }
  if (serviceScope && !SERVICE_SCOPES.includes(serviceScope)) {
    details.service_scope = `Service scope must be one of ${SERVICE_SCOPES.join(', ')}`;
  }
  if (!['active', 'inactive', 'all'].includes(status)) details.status = 'Status must be active, inactive or all';
  throwIfInvalid(details);

  // Office Head / Office Staff only ever see their own office; another office's filter is a 403.
  let scopedOfficeId = officeId;
  if (isOfficeBound(user.role)) {
    if (!user.officeId || (officeId && officeId.toLowerCase() !== String(user.officeId).toLowerCase())) throw Errors.forbidden();
    scopedOfficeId = user.officeId;
  }

  const where = [];
  const values = [manilaToday()];
  const add = (sql, value) => {
    values.push(value);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  const effectiveStatus = user.role === ROLES.SUPER_ADMIN ? status : 'active';
  if (effectiveStatus === 'active') where.push('s.is_active = true');
  if (effectiveStatus === 'inactive') where.push('s.is_active = false');
  if (scopedOfficeId) add('s.office_id = ?::uuid', scopedOfficeId);
  if (classification) add('s.classification = ?', classification);
  if (serviceScope) add('s.service_scope = ?', serviceScope);
  if (search) add('(s.service_name ILIKE ? OR s.service_code ILIKE ? OR o.office_name ILIKE ?)', likePattern(search));
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const [{ total }] = await dataSource.query(`SELECT count(*)::int AS total FROM (${SERVICE_SELECT}${whereSql}) t`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await dataSource.query(
    `${SERVICE_SELECT}${whereSql} ORDER BY lower(s.service_name), s.service_id LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.map(toServiceDto), page, page_size: pageSize, total };
}

/** One service with its version history and checklist. Inactive => 404 unless Super Admin; another office => 403 for Office Head / Office Staff. */
export async function getServiceDetail(dataSource, user, id) {
  const service = isUuid(id) ? await loadServiceDto(dataSource, id) : null;
  if (!service || (!service.is_active && user.role !== ROLES.SUPER_ADMIN)) {
    throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  }
  assertOfficeAccess(user, service.office_id);
  const standards = (await listStandardRows(dataSource, id)).map(toStandardDto);
  const documents = (await listDocumentRows(dataSource, id)).map(toDocumentDto);
  return { service, standards, documents };
}
