import { ROLES, json, requirePermission, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { previewServiceCode } from '../../../../lib/catalogue/service-codes.js';
export const dynamic = 'force-dynamic';
const canWrite = requirePermission([ROLES.SUPER_ADMIN], 'campus');
export const GET = route(async (request) => {
  await canWrite(request);
  const params = new URL(request.url).searchParams;
  return json(await previewServiceCode(await getDb(), params.get('officeId'), params.get('abbr')));
});
