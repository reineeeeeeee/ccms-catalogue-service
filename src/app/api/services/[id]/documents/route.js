import { ROLES, Errors, clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { addDocument } from '../../../../../lib/catalogue/documents.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// POST /services/:id/documents — Super Admin only. Checklist item (a name, never a file).
export const POST = route(async (request, { params }) => {
  const user = await canWrite(request);
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  const document = await addDocument(await getDb(), user, params.id, await readJson(request), { ipAddress: clientIp(request) });
  return json({ document }, 201);
});
