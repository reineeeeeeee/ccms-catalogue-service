import { Errors, ROLES, clientIp, isUuid, json, noContent, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { deleteException, updateException } from '../../../../lib/calendar/exceptions.js';

export const dynamic = 'force-dynamic';

const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');

function entryId(params) {
  if (!isUuid(params.id)) throw Errors.notFound('Calendar entry not found', 'CALENDAR_ENTRY_NOT_FOUND');
  return params.id;
}

// PUT /exceptions/:id — Super Admin only (full replacement of the entry's fields).
export const PUT = route(async (request, { params }) => {
  const user = await canWrite(request);
  const id = entryId(params);
  const exception = await updateException(await getDb(), user, id, await readJson(request), { ipAddress: clientIp(request) });
  return json({ exception });
});

// DELETE /exceptions/:id — Super Admin only. A recurring entry is removed for every year.
export const DELETE = route(async (request, { params }) => {
  const user = await canWrite(request);
  await deleteException(await getDb(), user, entryId(params), { ipAddress: clientIp(request) });
  return noContent();
});
