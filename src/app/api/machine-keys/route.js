import { ROLES, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { issueMachineKey, listMachineKeys } from '../../../lib/machine-keys.js';

export const dynamic = 'force-dynamic';

const superAdmin = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /machine-keys — Super Admin. Metadata only: the key and its hash are never returned.
export const GET = route(async (request) => {
  await superAdmin(request);
  return json({ items: await listMachineKeys(await getDb()) });
});

// POST /machine-keys { caller, environment, scope? } — Super Admin. The reply carries the key ONCE; it cannot be read again.
export const POST = route(async (request) => {
  const user = await superAdmin(request);
  const result = await issueMachineKey(await getDb(), user, await readJson(request), { ipAddress: clientIp(request) });
  return json(result, 201, { 'cache-control': 'no-store' });
});
