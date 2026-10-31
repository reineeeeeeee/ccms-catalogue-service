import { json, readJson, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { assertCallerOffice, authenticateCaller } from '../../../lib/calendar/engine-auth.js';
import { deadline, parseEngineOfficeId } from '../../../lib/calendar/engine-service.js';

export const dynamic = 'force-dynamic';

// POST /deadline { start, workingDays, officeId, heldMinutes } -> { deadline } (ISO timestamp, +08:00).
export const POST = route(async (request) => {
  const caller = await authenticateCaller(request);
  const body = await readJson(request);
  assertCallerOffice(caller, parseEngineOfficeId(body.officeId));
  return json(await deadline(await getDb(), body));
});
