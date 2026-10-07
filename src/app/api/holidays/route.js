import { Errors, isValidManilaDate, json, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { assertCallerOffice, authenticateCaller } from '../../../lib/calendar/engine-auth.js';
import { parseEngineOfficeId } from '../../../lib/calendar/engine-service.js';
import { listEffectiveHolidays } from '../../../lib/calendar/exceptions.js';
import { dayIndexOfDate, MAX_SPAN_DAYS } from '../../../lib/calendar/engine/working-time.js';

export const dynamic = 'force-dynamic';

function dateParam(params, name) {
  const value = params.get(name);
  if (!value || !isValidManilaDate(value)) {
    throw Errors.validation(`${name} must be a date (YYYY-MM-DD)`, { [name]: `${name} must be a date (YYYY-MM-DD)` });
  }
  return value;
}

// GET /holidays?from=&to=&officeId= -> { items: [{ date, exception_type, description, office_id, suspended_from }] }.
// Entries effective in the range, recurring ones expanded per year. Campus-wide only when officeId is absent.
export const GET = route(async (request) => {
  const caller = await authenticateCaller(request);
  const params = new URL(request.url).searchParams;
  const from = dateParam(params, 'from');
  const to = dateParam(params, 'to');
  if (from > to) throw Errors.validation('from must not be after to', { from: 'from must not be after to' });
  if (dayIndexOfDate(to) - dayIndexOfDate(from) > MAX_SPAN_DAYS) {
    throw Errors.validation(`The range must not be longer than ${MAX_SPAN_DAYS} days`, { to: 'Range is too long' });
  }
  const officeId = parseEngineOfficeId(params.get('officeId'));
  assertCallerOffice(caller, officeId);
  return json({ items: await listEffectiveHolidays(await getDb(), { from, to, officeId }) });
});
