import { Errors, ROLES, clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { rotateMachineKey } from '../../../../../lib/machine-keys.js';

export const dynamic = 'force-dynamic';

const superAdmin = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// POST /machine-keys/:id/rotate { overlap_days? 0-7, default 7 } — Super Admin. Returns the new key once.
export const POST = route(async (request, { params }) => {
  const user = await superAdmin(request);
  const { id } = await params;
  if (!isUuid(id)) throw Errors.notFound('Machine key not found', 'MACHINE_KEY_NOT_FOUND');
  const body = await readJson(request).catch(() => ({}));
  return json(await rotateMachineKey(await getDb(), user, id, body, { ipAddress: clientIp(request) }), 201, { 'cache-control': 'no-store' });
});
