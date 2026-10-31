import { ROLES, ROLE_LIST, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { createService, listServices } from '../../../lib/catalogue/services.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /services — any signed-in role. Only Super Admin can see inactive services.
export const GET = route(async (request) => {
  const user = await canRead(request);
  return json(await listServices(await getDb(), user, new URL(request.url).searchParams));
});

// POST /services — Super Admin only. Creates the service and its first standard together.
export const POST = route(async (request) => {
  const user = await canWrite(request);
  const service = await createService(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json({ service }, 201);
});
