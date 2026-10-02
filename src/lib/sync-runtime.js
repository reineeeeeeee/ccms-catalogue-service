import { startSyncDispatcher } from './sync-dispatcher.js';
import { getDb } from './data-source.js';

const KEY = '__ccmsSyncDispatcher';

/** Sync settings from the environment (retry interval and attempts are team-set). */
export function syncSettings(env = process.env) {
  const number = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    urls: { FMS: env.FMS_URL || null, AUDIT: env.AUDIT_URL || null },
    serviceKey: env.SERVICE_KEY,
    retryIntervalMs: number('SYNC_RETRY_INTERVAL_SECONDS', 60) * 1000,
    maxAttempts: Math.floor(number('SYNC_MAX_ATTEMPTS', 20)),
    pollIntervalMs: number('SYNC_POLL_INTERVAL_SECONDS', 5) * 1000,
    timeoutMs: number('SYNC_TIMEOUT_SECONDS', 5) * 1000,
  };
}

/** Starts the background sender that pushes SyncLog rows to FMS and Audit. */
export function startSyncRuntime() {
  if (globalThis[KEY]) return;
  const settings = syncSettings();
  if (!settings.serviceKey) {
    console.warn('Calendar sync dispatcher not started: SERVICE_KEY is required.');
    return;
  }
  if (!settings.urls.FMS || !settings.urls.AUDIT) {
    console.warn('FMS_URL and/or AUDIT_URL are not set: pushes to that system will be marked FAILED and retried.');
  }
  globalThis[KEY] = startSyncDispatcher({ getDb, ...settings });
}

/** Sends due pushes right away. Call after a transaction commits; safe if not started. */
export function kickSync() {
  globalThis[KEY]?.kick();
}

export function stopSyncRuntime() {
  globalThis[KEY]?.stop();
  globalThis[KEY] = undefined;
}
