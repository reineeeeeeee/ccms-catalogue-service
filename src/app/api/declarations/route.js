import { json, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { listDeclarations } from '../../../lib/calendar/declarations.js';
import { requireMachineKey } from '../../../lib/machine-keys.js';

export const dynamic = 'force-dynamic';

// GET /declarations?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=&limit= (EB6). The pull snapshot for FMS: every calendar entry in the
// range, removals included, in the shape of a pushed message. Machine key only (EB7): `Authorization: Bearer ccms_mk_...`
// with the read-calendar scope. A signed-in user's token and the shared service key are both refused with 401.
export const GET = route(async (request) => {
  const db = await getDb();
  await requireMachineKey(request, db, 'read-calendar');
  const query = Object.fromEntries(new URL(request.url).searchParams);
  return json(await listDeclarations(db, query));
});
