import { json, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { assertCallerOffice, authenticateCaller } from '../../../lib/calendar/engine-auth.js';
import { isWorkingDay, parseEngineOfficeId } from '../../../lib/calendar/engine-service.js';

export const dynamic = 'force-dynamic';

// GET /is-working-day?date=YYYY-MM-DD&officeId= -> { is_working_day, window: { opening_time, closing_time } | null }.
export const GET = route(async (request) => {
  const caller = await authenticateCaller(request);
  const params = new URL(request.url).searchParams;
  const officeId = parseEngineOfficeId(params.get('officeId'));
  assertCallerOffice(caller, officeId);
  return json(await isWorkingDay(await getDb(), { date: params.get('date'), officeId }));
});
