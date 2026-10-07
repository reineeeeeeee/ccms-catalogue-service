import { randomUUID } from 'node:crypto';
import { SyncLog } from '../entities/index.js';

/**
 * Sends due SyncLog rows (PENDING or FAILED, with attempts left) to FMS_URL / AUDIT_URL with the
 * shared service key. Success marks the row SENT; a failure marks it FAILED and schedules the next
 * try after retryIntervalMs, until maxAttempts. A failed push never touches the saved change.
 * Re-sending is safe: the payload carries its sync_id.
 */
export async function dispatchSyncLogs(
  dataSource,
  { urls, serviceKey, fetchImpl = fetch, retryIntervalMs = 60_000, maxAttempts = 20, batchSize = 50, timeoutMs = 5000, leaseMs = 60_000, now = () => new Date() },
) {
  const repo = dataSource.getRepository(SyncLog);
  // Claim the due rows atomically (SKIP LOCKED) and push their next attempt forward by a lease, so two
  // overlapping cron runs never send the same row. A run that dies midway leaves the lease to expire.
  const claimed = await dataSource.query(
    `UPDATE sync_log SET next_attempt_at = $3
     WHERE sync_id IN (
       SELECT sync_id FROM sync_log
       WHERE status IN ('PENDING', 'FAILED') AND attempts < $1 AND next_attempt_at <= $2
       ORDER BY created_at ASC LIMIT $4
       FOR UPDATE SKIP LOCKED)
     RETURNING sync_id, consumer_system, payload, created_at`,
    [maxAttempts, now(), new Date(now().getTime() + leaseMs), batchSize],
  );
  // TypeORM returns [rows, count] for UPDATE ... RETURNING.
  const claimedRows = Array.isArray(claimed[0]) ? claimed[0] : claimed;
  const due = claimedRows
    .map((r) => ({ syncId: r.sync_id, consumerSystem: r.consumer_system, payload: r.payload, createdAt: r.created_at }))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

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
