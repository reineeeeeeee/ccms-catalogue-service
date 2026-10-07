import { Errors, json, readJson, requireServiceKey, route } from 'ccms-shared';
import { getDb } from '../../../../lib/data-source.js';
import { acknowledgeSync } from '../../../../lib/calendar/sync.js';

export const dynamic = 'force-dynamic';

// POST /sync/ack { sync_id } — Audit's acknowledgment (link #3). Shared service key only.
export const POST = route(async (request) => {
  requireServiceKey(request);
  const body = await readJson(request);
  if (typeof body.sync_id !== 'string' || !body.sync_id) {
    throw Errors.validation('sync_id is required', { sync_id: 'sync_id is required' });
  }
  return json(await acknowledgeSync(await getDb(), body.sync_id));
});
