import { json, route } from 'ccms-shared';
import { getDb } from '../../../../../lib/data-source.js';
import { getPublicService, limitPublicRequest } from '../../../../../lib/catalogue/public-catalogue.js';

export const dynamic = 'force-dynamic';

// GET /public/services/:id — no login, rate limited. Public fields only.
export const GET = route(async (request, { params, correlationId }) => {
  const limited = await limitPublicRequest(request, correlationId);
  if (limited) return limited;
  return json(await getPublicService(await getDb(), params.id));
});
