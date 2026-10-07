import { getDb } from '../lib/data-source.js';
import { dispatchSyncLogs } from '../lib/calendar/sync-dispatch.js';

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
    timeoutMs: number('SYNC_TIMEOUT_SECONDS', 5) * 1000,
  };
}

/**
 * Pushes due SyncLog rows (calendar and term changes) to FMS and Audit, and retries failed ones.
 * Run by the Vercel Cron route (/api/jobs/calendar-sync) and right after a change commits.
 */
export async function runCalendarSync({ env = process.env, ...overrides } = {}) {
  const settings = syncSettings(env);
  if (!settings.serviceKey) return { skipped: true, reason: 'SERVICE_KEY is required', sent: 0, failed: 0 };
  return { skipped: false, ...(await dispatchSyncLogs(await getDb(), { ...settings, ...overrides })) };
}
