import { ROLES, ROLE_LIST, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { createOffice, listOffices } from '../../../lib/catalogue/offices.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /offices — every signed-in user (active offices; Super Admin also sees inactive ones).
export const GET = route(async (request) => {
  const user = await canRead(request);
  const q = new URL(request.url).searchParams.get('q');
  return json({ items: await listOffices(await getDb(), user, { q }) });
});

// POST /offices — Super Admin only.
export const POST = route(async (request) => {
  const user = await canWrite(request);
  const office = await createOffice(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json({ office }, 201);
});
