import { ROLES, Errors, clientIp, isUuid, json, noContent, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../../lib/data-source.js';
import { removeDocument, updateDocument } from '../../../../../../lib/catalogue/documents.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

function ids(params) {
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  if (!isUuid(params.documentId)) throw Errors.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
  return [params.id, params.documentId];
}

// PUT /services/:id/documents/:documentId — Super Admin only.
export const PUT = route(async (request, { params }) => {
  const user = await canWrite(request);
  const [serviceId, documentId] = ids(params);
  const document = await updateDocument(await getDb(), user, serviceId, documentId, await readJson(request), { ipAddress: clientIp(request) });
  return json({ document });
});

// DELETE /services/:id/documents/:documentId — Super Admin only.
export const DELETE = route(async (request, { params }) => {
  const user = await canWrite(request);
  const [serviceId, documentId] = ids(params);
  await removeDocument(await getDb(), user, serviceId, documentId, { ipAddress: clientIp(request) });
  return noContent();
});
