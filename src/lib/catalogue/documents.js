import { randomUUID } from 'node:crypto';
import { Errors, isUniqueViolation, recordAudit } from 'ccms-shared';
import { collapseSpaces, nameKey, throwIfInvalid } from './catalogue-rules.js';
import { RequiredDocument } from '../entities/index.js';
import { kickOutbox } from '../outbox.js';

export const DOCUMENT_NAME_TAKEN = 'This service already has a document with this name';
const MAX_NAME = 250; // team-set
const MAX_NOTES = 1000;

export function toDocumentDto(row) {
  return {
    document_id: row.document_id,
    service_id: row.service_id,
    document_name: row.document_name,
    is_mandatory: row.is_mandatory,
    notes: row.notes ?? null,
  };
}

const COLUMNS = 'document_id, service_id, document_name, is_mandatory, notes';

/** The checklist in a stable order: mandatory items first, then by name. */
export function listDocumentRows(manager, serviceId) {
  return manager.query(
    `SELECT ${COLUMNS} FROM required_documents WHERE service_id = $1 ORDER BY is_mandatory DESC, lower(document_name), document_id`,
    [serviceId],
  );
}

/** document_name required (names only, never files); is_mandatory boolean (default true); notes optional text. */
export function parseDocumentInput(body) {
  const details = {};
  const name = typeof body.document_name === 'string' ? collapseSpaces(body.document_name) : '';
  if (!name) details.document_name = 'Document name is required';
  else if (name.length > MAX_NAME) details.document_name = `Document name must be ${MAX_NAME} characters or fewer`;
  else if (/[<>"`]/.test(name)) details.document_name = 'Document name cannot contain < > " or ` characters';

  let isMandatory = true;
  if (body.is_mandatory !== undefined) {
    if (typeof body.is_mandatory === 'boolean') isMandatory = body.is_mandatory;
    else details.is_mandatory = 'Mandatory must be true or false';
  }
  let notes = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') details.notes = 'Notes must be text';
    else if (body.notes.length > MAX_NOTES) details.notes = `Notes must be ${MAX_NOTES} characters or fewer`;
    else notes = body.notes.trim() === '' ? null : body.notes.trim();
  }
  throwIfInvalid(details);
  return { documentName: name, documentNameKey: nameKey(name), isMandatory, notes };
}

async function lockService(manager, serviceId) {
  const rows = await manager.query('SELECT service_id, office_id FROM services WHERE service_id = $1 FOR UPDATE', [serviceId]);
  if (!rows[0]) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  return rows[0];
}

async function loadDocument(manager, serviceId, documentId) {
  const rows = await manager.query(`SELECT ${COLUMNS} FROM required_documents WHERE service_id = $1 AND document_id = $2`, [serviceId, documentId]);
  if (!rows[0]) throw Errors.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
  return toDocumentDto(rows[0]);
}

async function assertNameFree(manager, serviceId, key, exceptId = null) {
  const rows = await manager.query(
    'SELECT 1 FROM required_documents WHERE service_id = $1 AND document_name_key = $2 AND ($3::uuid IS NULL OR document_id <> $3::uuid) LIMIT 1',
    [serviceId, key, exceptId],
  );
  if (rows.length) throw Errors.conflict(DOCUMENT_NAME_TAKEN, 'DOCUMENT_NAME_EXISTS', { document_name: DOCUMENT_NAME_TAKEN });
}

function audit(manager, actor, action, service, before, after, ipAddress) {
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'RequiredDocument',
    entityId: (after ?? before).document_id,
    officeId: service.office_id,
    before,
    after,
    ipAddress,
  });
}

function mapUnique(err) {
  if (isUniqueViolation(err, 'required_documents_name_uq')) {
    return Errors.conflict(DOCUMENT_NAME_TAKEN, 'DOCUMENT_NAME_EXISTS', { document_name: DOCUMENT_NAME_TAKEN });
  }
  return null;
}

export async function addDocument(dataSource, actor, serviceId, body, { ipAddress } = {}) {
  const input = parseDocumentInput(body);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const service = await lockService(manager, serviceId);
      await assertNameFree(manager, serviceId, input.documentNameKey);
      const documentId = randomUUID();
      await manager.getRepository(RequiredDocument).insert({ documentId, serviceId, ...input });
      const created = await loadDocument(manager, serviceId, documentId);
      await audit(manager, actor, 'REQUIRED_DOCUMENT_ADDED', service, null, created, ipAddress);
      return created;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    throw mapUnique(err) ?? err;
  }
}

export async function updateDocument(dataSource, actor, serviceId, documentId, body, { ipAddress } = {}) {
  const input = parseDocumentInput(body);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const service = await lockService(manager, serviceId);
      const before = await loadDocument(manager, serviceId, documentId);
      if (before.document_name === input.documentName && before.is_mandatory === input.isMandatory && before.notes === input.notes) {
        return before;
      }
      await assertNameFree(manager, serviceId, input.documentNameKey, documentId);
      await manager.getRepository(RequiredDocument).update({ documentId }, input);
      const after = await loadDocument(manager, serviceId, documentId);
      await audit(manager, actor, 'REQUIRED_DOCUMENT_UPDATED', service, before, after, ipAddress);
      return after;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    throw mapUnique(err) ?? err;
  }
}

export async function removeDocument(dataSource, actor, serviceId, documentId, { ipAddress } = {}) {
  await dataSource.transaction(async (manager) => {
    const service = await lockService(manager, serviceId);
    const before = await loadDocument(manager, serviceId, documentId);
    await manager.getRepository(RequiredDocument).delete({ documentId });
    await audit(manager, actor, 'REQUIRED_DOCUMENT_REMOVED', service, before, null, ipAddress);
  });
  kickOutbox();
}
