import { ROLES, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { getSyncStatus } from '../../../../lib/calendar/sync.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /sync/status — Super Admin only (RBAC doc 4.3: "View sync status (FMS/Audit)").
export const GET = route(async (request) => {
  await canRead(request);
  return json(await getSyncStatus(await getDb()));
});
