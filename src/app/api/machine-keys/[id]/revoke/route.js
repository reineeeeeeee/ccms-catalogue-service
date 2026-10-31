import { Errors, ROLES, clientIp, isUuid, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { revokeMachineKey } from '../../../../../lib/machine-keys.js';

export const dynamic = 'force-dynamic';

const superAdmin = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// POST /machine-keys/:id/revoke — Super Admin. The key is refused from the next request on.
export const POST = route(async (request, { params }) => {
  const user = await superAdmin(request);
  const { id } = await params;
  if (!isUuid(id)) throw Errors.notFound('Machine key not found', 'MACHINE_KEY_NOT_FOUND');
  return json({ machine_key: await revokeMachineKey(await getDb(), user, id, { ipAddress: clientIp(request) }) });
});
