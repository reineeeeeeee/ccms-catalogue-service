import { ROLE_LIST, Errors, hasValidServiceKey, isUuid, isValidManilaDate, json, requirePermission, route } from 'ccms-shared';
import { manilaToday } from '../../../../../lib/catalogue/catalogue-rules.js';
import { getDb } from '../../../../../lib/data-source.js';
import { getStandardAsOf } from '../../../../../lib/catalogue/standards.js';

export const dynamic = 'force-dynamic';

const canRead = requirePermission(ROLE_LIST, 'campus');

// GET /services/:id/standard?asOf=YYYY-MM-DD — the version in force on that Manila date (default: today).
// Callable with the shared service key (Transaction, any office) or a signed-in token
// (Office Head / Office Staff: own office only, else 403).
export const GET = route(async (request, { params }) => {
  const viewer = hasValidServiceKey(request) ? null : await canRead(request);
  if (!isUuid(params.id)) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  const asOf = new URL(request.url).searchParams.get('asOf') || manilaToday();
  if (!isValidManilaDate(asOf)) {
    throw Errors.validation('asOf must be a date (YYYY-MM-DD)', { asOf: 'asOf must be a date (YYYY-MM-DD)' });
  }
  return json(await getStandardAsOf(await getDb(), params.id, asOf, viewer));
});
