import { json, readJson, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { assertCallerOffice, authenticateCaller } from '../../../lib/calendar/engine-auth.js';
import { addWorkingMinutes, parseEngineOfficeId } from '../../../lib/calendar/engine-service.js';

export const dynamic = 'force-dynamic';

// POST /add-working-minutes { datetime, minutes, officeId } -> { datetime }. Service key or signed-in token.
export const POST = route(async (request) => {
  const caller = await authenticateCaller(request);
  const body = await readJson(request);
  assertCallerOffice(caller, parseEngineOfficeId(body.officeId));
  return json(await addWorkingMinutes(await getDb(), body));
});
