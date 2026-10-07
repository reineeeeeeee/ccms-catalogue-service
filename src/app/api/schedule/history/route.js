import { ROLES, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { listScheduleHistory } from '../../../../lib/calendar/schedule.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission([ROLES.SUPER_ADMIN], 'campus');

// GET /schedule/history — Super Admin only: the saved versions of the campus schedule, newest first.
export const GET = route(async (request) => {
  await canRead(request);
  return json(await listScheduleHistory(await getDb()));
});
