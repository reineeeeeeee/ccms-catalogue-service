import { ROLES, Errors, clientIp, isUuid, noContent, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../../lib/data-source.js';
import { deleteStandard } from '../../../../../../lib/catalogue/standards.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// DELETE /services/:id/standards/:standardId — Super Admin only, and only a version that has not started yet.
export const DELETE = route(async (request, { params }) => {
  const user = await canWrite(request);
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  if (!isUuid(params.standardId)) throw Errors.notFound('Standard not found', 'STANDARD_NOT_FOUND');
  await deleteStandard(await getDb(), user, params.id, params.standardId, { ipAddress: clientIp(request) });
  return noContent();
});
