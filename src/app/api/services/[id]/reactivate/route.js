import { ROLES, Errors, clientIp, isUuid, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { setServiceActive } from '../../../../../lib/catalogue/services.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// PATCH /services/:id/reactivate — Super Admin only. Services are never deleted.
export const PATCH = route(async (request, { params }) => {
  const user = await canWrite(request);
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  const service = await setServiceActive(await getDb(), user, params.id, true, { ipAddress: clientIp(request) });
  return json({ service });
});
