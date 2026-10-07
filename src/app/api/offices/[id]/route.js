import { ROLES, ROLE_LIST, Errors, clientIp, hasValidServiceKey, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { getOffice, updateOffice } from '../../../../lib/catalogue/offices.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

function officeId(params) {
  if (!isUuid(params.id)) throw Errors.notFound('Office not found', 'OFFICE_NOT_FOUND');
  return params.id;
}

// GET /offices/:id — Identity's account office check (shared service key), or any signed-in user.
// Without either credential this is a 401.
export const GET = route(async (request, { params }) => {
  const id = officeId(params);
  const viewer = hasValidServiceKey(request) ? null : await canRead(request);
  return json({ office: await getOffice(await getDb(), id, viewer) });
});

// PUT /offices/:id — Super Admin only.
export const PUT = route(async (request, { params }) => {
  const id = officeId(params);
  const user = await canWrite(request);
  const office = await updateOffice(await getDb(), user, id, await readJson(request), { ipAddress: clientIp(request) });
  return json({ office });
});
