import { startOutboxDispatcher } from 'ccms-shared';
import { getDb } from './data-source.js';

const KEY = '__ccmsOutbox';

/** Starts the background sender that delivers outbox audit events to the Logs service. */
export function startDispatcher() {
  if (globalThis[KEY]) return;
  const logsUrl = process.env.LOGS_SERVICE_URL;
  const serviceKey = process.env.SERVICE_KEY;
  if (!logsUrl || !serviceKey) {
    console.warn('Audit outbox dispatcher not started: LOGS_SERVICE_URL and SERVICE_KEY are required.');
    return;
  }
  globalThis[KEY] = startOutboxDispatcher({ getDb, logsUrl, serviceKey });
}

/** Sends pending events right away. Call after a transaction commits; safe if not started. */
export function kickOutbox() {
  globalThis[KEY]?.kick();
}
