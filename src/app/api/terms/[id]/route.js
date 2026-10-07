import { Errors, ROLES, clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { updateTerm } from '../../../../lib/calendar/terms.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// PUT /terms/:id — Super Admin only.
export const PUT = route(async (request, { params }) => {
  const user = await canWrite(request);
  if (!isUuid(params.id)) throw Errors.notFound('Term not found', 'TERM_NOT_FOUND');
  const term = await updateTerm(await getDb(), user, params.id, await readJson(request), { ipAddress: clientIp(request) });
  return json({ term });
});
