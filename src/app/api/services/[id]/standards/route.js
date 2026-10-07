import { ROLES, ROLE_LIST, Errors, clientIp, isUuid, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { createStandard, listStandards } from '../../../../../lib/catalogue/standards.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

const serviceId = (params) => {
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  return params.id;
};

// GET /services/:id/standards — version history, newest first.
export const GET = route(async (request, { params }) => {
  const user = await canRead(request);
  return json({ items: await listStandards(await getDb(), user, serviceId(params)) });
});

// POST /services/:id/standards — Super Admin only. A new version from effective_from.
export const POST = route(async (request, { params }) => {
  const user = await canWrite(request);
  const standard = await createStandard(await getDb(), user, serviceId(params), await readJson(request), { ipAddress: clientIp(request) });
  return json({ standard }, 201);
});
