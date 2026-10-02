import { json, readJson, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { assertCallerOffice, authenticateCaller } from '../../../lib/engine-auth.js';
import { parseEngineOfficeId, workingMinutes } from '../../../lib/engine-service.js';

export const dynamic = 'force-dynamic';

// POST /working-minutes { start, end, officeId } -> { working_minutes }. Service key or signed-in token.
export const POST = route(async (request) => {
  const caller = await authenticateCaller(request);
  const body = await readJson(request);
  assertCallerOffice(caller, parseEngineOfficeId(body.officeId));
  return json(await workingMinutes(await getDb(), body));
});
