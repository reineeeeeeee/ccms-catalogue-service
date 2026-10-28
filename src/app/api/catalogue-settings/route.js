import { ROLE_LIST, clientIp, json, readJson, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { getCatalogueSettings, updateCatalogueSettings } from '../../../lib/catalogue/settings.js';

export const dynamic = 'force-dynamic';
const signedIn = requirePermission(ROLE_LIST, 'campus');
export const GET = route(async (request) => {
  await signedIn(request);
  return json({ settings: await getCatalogueSettings(await getDb()) });
});
export const PUT = route(async (request) => {
  const actor = await signedIn(request);
  return json({ settings: await updateCatalogueSettings(await getDb(), actor, await readJson(request), { ipAddress: clientIp(request) }) });
});
