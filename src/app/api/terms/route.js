import { ROLES, ROLE_LIST, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { createTerm, listTerms } from '../../../lib/calendar/terms.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /terms — any signed-in user.
export const GET = route(async (request) => {
  await canRead(request);
  return json({ items: await listTerms(await getDb()) });
});

// POST /terms — Super Admin only.
export const POST = route(async (request) => {
  const user = await canWrite(request);
  const term = await createTerm(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json({ term }, 201);
});
