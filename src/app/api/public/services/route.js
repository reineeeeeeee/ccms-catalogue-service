import { json, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { limitPublicRequest, listPublicServices } from '../../../../lib/catalogue/public-catalogue.js';

export const dynamic = 'force-dynamic';

// GET /public/services — no login, rate limited. Active services with a standard in force today.
export const GET = route(async (request, { correlationId }) => {
  const limited = await limitPublicRequest(request, correlationId);
  if (limited) return limited;
  return json(await listPublicServices(await getDb(), new URL(request.url).searchParams));
});
