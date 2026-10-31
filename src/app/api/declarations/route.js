import { json, requireServiceKey, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { listDeclarations } from '../../../lib/calendar/declarations.js';

export const dynamic = 'force-dynamic';

// GET /declarations?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=&limit= (EB6). The pull snapshot for FMS: every calendar entry in the
// range, removals included, in the shape of a pushed message. Machine key only: a signed-in user's token is not accepted
// (AC4). Until the machine-key rules of EB7 (expiry, rotation, revocation) are built, the shared service key is the key.
export const GET = route(async (request) => {
  requireServiceKey(request);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  return json(await listDeclarations(await getDb(), query));
});
