import { ROLES, ROLE_LIST, clientIp, json, readJson, requirePermission, route, hasValidServiceKey } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { getSchedule, updateSchedule } from '../../../lib/calendar/schedule.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /schedule — any signed-in user, or the shared service key (Transaction, Reports).
export const GET = route(async (request) => {
  if (!hasValidServiceKey(request)) await canRead(request);
  return json({ items: await getSchedule(await getDb()) });
});

// PUT /schedule — Super Admin only. Body { days: [7 items] }.
export const PUT = route(async (request) => {
  const user = await canWrite(request);
  const items = await updateSchedule(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json({ items });
});
