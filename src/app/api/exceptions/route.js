import { ROLES, ROLE_LIST, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { createException, listExceptions } from '../../../lib/calendar/exceptions.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /exceptions?from=&to=&office_id=&type= — any signed-in user.
export const GET = route(async (request) => {
  const user = await canRead(request);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  return json({ items: await listExceptions(await getDb(), user, query) });
});

// POST /exceptions — Super Admin only.
export const POST = route(async (request) => {
  const user = await canWrite(request);
  const exception = await createException(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json({ exception }, 201);
});
