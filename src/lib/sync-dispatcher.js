import { randomUUID } from 'node:crypto';
import { SyncLog } from './entities/index.js';

/**
 * Sends due SyncLog rows (PENDING or FAILED, with attempts left) to FMS_URL / AUDIT_URL with the
 * shared service key. Success marks the row SENT; a failure marks it FAILED and schedules the next
 * try after retryIntervalMs, until maxAttempts. A failed push never touches the saved change.
 * Re-sending is safe: the payload carries its sync_id.
 */
export async function dispatchSyncLogs(
  dataSource,
  { urls, serviceKey, fetchImpl = fetch, retryIntervalMs = 60_000, maxAttempts = 20, batchSize = 50, timeoutMs = 5000, now = () => new Date() },
) {
  const repo = dataSource.getRepository(SyncLog);
  const due = await repo
    .createQueryBuilder('s')
    .where("s.status IN ('PENDING', 'FAILED') AND s.attempts < :maxAttempts AND s.nextAttemptAt <= :now", {
      maxAttempts,
      now: now(),
    })
    .orderBy('s.createdAt', 'ASC')
    .limit(batchSize)
    .getMany();

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const url = urls?.[row.consumerSystem];
    const attemptAt = now();
    try {
      if (!url) throw new Error(`${row.consumerSystem}_URL is not configured`);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-key': serviceKey ?? '',
          'x-correlation-id': randomUUID(),
        },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.arrayBuffer?.().catch(() => {});
      if (!response.ok) throw new Error(`${row.consumerSystem} responded ${response.status}`);
      // Only rows still waiting are marked SENT: an acknowledgment that raced ahead stays ACKNOWLEDGED.
      await repo
        .createQueryBuilder()
        .update()
        .set({
          status: 'SENT',
          attempts: () => 'attempts + 1',
          lastAttemptAt: attemptAt,
          lastSyncedAt: attemptAt,
          lastError: null,
        })
        .where("sync_id = :id AND status IN ('PENDING', 'FAILED')", { id: row.syncId })
        .execute();
      sent += 1;
    } catch (err) {
      await repo
        .createQueryBuilder()
        .update()
        .set({
          status: 'FAILED',
          attempts: () => 'attempts + 1',
          lastAttemptAt: attemptAt,
          lastError: String(err.message).slice(0, 500),
          nextAttemptAt: new Date(attemptAt.getTime() + retryIntervalMs),
        })
        .where("sync_id = :id AND status IN ('PENDING', 'FAILED')", { id: row.syncId })
        .execute();
      failed += 1;
    }
  }
  return { sent, failed };
}

/** Background dispatcher. kick() sends right away (called after a commit); it also polls for retries. */
export function startSyncDispatcher({ getDb, pollIntervalMs = 5000, ...options }) {
  let running = false;
  let again = false;

  async function tick() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await dispatchSyncLogs(await getDb(), options);
      } while (again);
    } catch (err) {
      console.error('Calendar sync dispatch failed:', err.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();
  return {
    kick: () => {
      tick();
    },
    stop: () => clearInterval(timer),
  };
}
