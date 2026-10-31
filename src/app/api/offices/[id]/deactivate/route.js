import { ROLES, Errors, clientIp, isUuid, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { setOfficeActive } from '../../../../../lib/catalogue/offices.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// PATCH /offices/:id/deactivate — Super Admin only. Offices are never deleted.
export const PATCH = route(async (request, { params }) => {
  if (!isUuid(params.id)) throw Errors.notFound('Office not found', 'OFFICE_NOT_FOUND');
  const user = await canWrite(request);
  const office = await setOfficeActive(await getDb(), user, params.id, false, { ipAddress: clientIp(request) });
  return json({ office });
});
