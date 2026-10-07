import { ROLES, ROLE_LIST, Errors, clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { getServiceDetail, updateService } from '../../../../lib/catalogue/services.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

const serviceId = (params) => {
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  return params.id;
};

// GET /services/:id — service, standards (newest first) and checklist. Inactive => 404 unless Super Admin.
export const GET = route(async (request, { params }) => {
  const user = await canRead(request);
  return json(await getServiceDetail(await getDb(), user, serviceId(params)));
});

// PUT /services/:id — Super Admin only. The standard is not editable here.
export const PUT = route(async (request, { params }) => {
  const user = await canWrite(request);
  const service = await updateService(await getDb(), user, serviceId(params), await readJson(request), { ipAddress: clientIp(request) });
  return json({ service });
});
