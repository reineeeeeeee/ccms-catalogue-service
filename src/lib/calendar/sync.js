import { Errors, isUuid } from 'ccms-shared';
import { newId } from './calendar-rules.js';
import { SyncLog } from '../entities/index.js';

export const CONSUMERS = Object.freeze(['FMS', 'AUDIT']);

/**
 * Queues one outward push per consumer for a change. Call it inside the same transaction as the
 * change so the rows exist if and only if the change committed. Sending happens later (and never
 * blocks or undoes the save). FMS receives calendar data; Audit receives calendar and term data.
 */
export async function enqueueSync(manager, { eventType, entityType, entityId, data, consumers = CONSUMERS }) {
  const occurredAt = new Date().toISOString();
  const repo = manager.getRepository(SyncLog);
  for (const consumerSystem of consumers) {
    const syncId = newId();
    await repo.insert({
      syncId,
      consumerSystem,
      eventType,
      entityType,
      entityId: entityId == null ? null : String(entityId),
      payload: {
        sync_id: syncId,
        consumer_system: consumerSystem,
        event_type: eventType,
        entity_type: entityType,
        entity_id: entityId == null ? null : String(entityId),
        occurred_at: occurredAt,
        data,
      },
      status: 'PENDING',
    });
  }
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

export function toSyncItem(row) {
  return {
    sync_id: row.syncId,
    consumer_system: row.consumerSystem,
    event_type: row.eventType,
    status: row.status,
    last_synced_at: iso(row.lastSyncedAt),
    attempts: row.attempts,
  };
}

/** GET /sync/status: when Audit last synced, the last FMS push, and the most recent rows. */
export async function getSyncStatus(dataSource, { limit = 20 } = {}) {
  const repo = dataSource.getRepository(SyncLog);
  const lastAudit = await repo
    .createQueryBuilder('s')
    .where("s.consumerSystem = 'AUDIT' AND s.status = 'ACKNOWLEDGED' AND s.lastSyncedAt IS NOT NULL")
    .orderBy('s.lastSyncedAt', 'DESC')
    .getOne();
  const lastFms = await repo
    .createQueryBuilder('s')
    .where("s.consumerSystem = 'FMS'")
    .orderBy('s.createdAt', 'DESC')
    .addOrderBy('s.syncId', 'DESC')
    .getOne();
  const recent = await repo
    .createQueryBuilder('s')
    .orderBy('s.createdAt', 'DESC')
    .addOrderBy('s.consumerSystem', 'ASC')
    .limit(limit)
    .getMany();
  return {
    audit_last_synced: iso(lastAudit?.lastSyncedAt),
    fms_last_push: lastFms ? { status: lastFms.status, at: iso(lastFms.lastAttemptAt ?? lastFms.createdAt) } : null,
    recent: recent.map(toSyncItem),
  };
}

/** POST /sync/ack: Audit confirms it received a push. Only Audit rows can be acknowledged. */
export async function acknowledgeSync(dataSource, syncId) {
  if (!isUuid(syncId)) throw Errors.notFound('Unknown sync ID', 'SYNC_NOT_FOUND');
  return dataSource.transaction(async (manager) => {
    const row = await manager.getRepository(SyncLog).findOne({ where: { syncId }, lock: { mode: 'pessimistic_write' } });
    if (!row) throw Errors.notFound('Unknown sync ID', 'SYNC_NOT_FOUND');
    if (row.consumerSystem !== 'AUDIT') {
      throw Errors.conflict('Only pushes to Audit can be acknowledged', 'SYNC_NOT_ACKNOWLEDGEABLE');
    }
    if (row.status !== 'ACKNOWLEDGED') {
      row.status = 'ACKNOWLEDGED';
      row.lastSyncedAt = new Date();
      row.lastError = null;
      await manager.getRepository(SyncLog).save(row);
    }
    return { sync_id: row.syncId, status: row.status, last_synced_at: iso(row.lastSyncedAt) };
  });
}
