import { Errors, recordAudit } from 'ccms-shared';
import { DEFAULT_SCHEDULE_SQL } from '../after-sync.js';
import { MSG, isHHMM, lockCalendar } from './calendar-rules.js';
import { WorkingHours } from '../entities/index.js';
import { kickSync } from '../outbox.js';
import { enqueueSync } from './sync.js';
import { kickOutbox } from '../outbox.js';
import { timeToMinutes } from './engine/working-time.js';

export function toScheduleItem(row) {
  return {
    day_of_week: row.dayOfWeek,
    is_working: row.isWorking,
    opening_time: row.isWorking ? row.openingTime : null,
    closing_time: row.isWorking ? row.closingTime : null,
  };
}

/** The seven schedule rows, Sunday first. Seeds the default when the table is empty or incomplete. */
export async function readSchedule(manager) {
  let rows = await manager.getRepository(WorkingHours).find({ order: { dayOfWeek: 'ASC' } });
  if (rows.length < 7) {
    await manager.query(DEFAULT_SCHEDULE_SQL);
    rows = await manager.getRepository(WorkingHours).find({ order: { dayOfWeek: 'ASC' } });
  }
  return rows.map(toScheduleItem);
}

function bad(message, details = null) {
  return Errors.validation(message, details ?? { days: message });
}

/**
 * Validates PUT /schedule { days: [7 items] } and returns the seven normalised items, Sunday first.
 * Times are 24-hour HH:MM: required on a working day, empty on a non-working day.
 */
export function parseScheduleInput(body) {
  if (!Array.isArray(body.days) || body.days.length !== 7) throw bad('days must list all 7 days of the week');
  const items = new Array(7).fill(null);
  for (const day of body.days) {
    if (day === null || typeof day !== 'object' || Array.isArray(day)) throw bad('Each day must be an object');
    const dow = day.day_of_week;
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw bad('day_of_week must be a whole number from 0 (Sunday) to 6 (Saturday)');
    if (items[dow]) throw bad('Each day of the week must appear exactly once');
    if (typeof day.is_working !== 'boolean') throw bad('is_working must be true or false for every day', { day_of_week: dow });

    const opening = day.opening_time === undefined || day.opening_time === '' ? null : day.opening_time;
    const closing = day.closing_time === undefined || day.closing_time === '' ? null : day.closing_time;
    if (!day.is_working) {
      if (opening !== null || closing !== null) {
        throw bad('Opening and closing times must be empty on a non-working day', { day_of_week: dow });
      }
      items[dow] = { day_of_week: dow, is_working: false, opening_time: null, closing_time: null };
      continue;
    }
    if (opening === null || closing === null) {
      throw bad('Opening and closing times are required on a working day', { day_of_week: dow });
    }
    if (!isHHMM(opening) || !isHHMM(closing)) {
      throw bad('Times must be in 24-hour HH:MM format', { day_of_week: dow });
    }
    if (timeToMinutes(closing) <= timeToMinutes(opening)) throw bad(MSG.CLOSING_AFTER_OPENING, { day_of_week: dow });
    items[dow] = { day_of_week: dow, is_working: true, opening_time: opening, closing_time: closing };
  }
  if (!items.some((item) => item.is_working)) throw bad(MSG.ONE_WORKING_DAY);
  return items;
}

export async function getSchedule(dataSource) {
  return dataSource.transaction((manager) => readSchedule(manager));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function updateSchedule(dataSource, actor, body, { ipAddress } = {}) {
  const next = parseScheduleInput(body);
  const result = await dataSource.transaction(async (manager) => {
    await lockCalendar(manager);
    const before = await readSchedule(manager);
    if (same(before, next)) return before;
    for (const item of next) {
      await manager.getRepository(WorkingHours).update(
        { dayOfWeek: item.day_of_week },
        { isWorking: item.is_working, openingTime: item.opening_time, closingTime: item.closing_time },
      );
    }
    const after = await readSchedule(manager);
    await recordAudit(manager, {
      actor,
      action: 'WORKING_HOURS_UPDATED',
      entityType: 'working_hours',
      entityId: 'campus',
      officeId: null,
      before: { items: before },
      after: { items: after },
      ipAddress,
    });
    await enqueueSync(manager, {
      eventType: 'WORKING_HOURS_UPDATED',
      entityType: 'working_hours',
      entityId: 'campus',
      data: { items: after },
      consumers: ['FMS', 'AUDIT'],
    });
    return after;
  });
  kickOutbox();
  kickSync();
  return result;
}

/**
 * Version history of the campus schedule, newest first: one entry per saved change, read from the
 * audit events the service recorded for it (WORKING_HOURS_UPDATED). version_no counts the saved
 * versions, so the newest entry has the highest number.
 */
export async function listScheduleHistory(dataSource, { limit = 20 } = {}) {
  const rows = await dataSource.query(
    `SELECT payload FROM audit_outbox WHERE payload->>'action' = 'WORKING_HOURS_UPDATED' ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM audit_outbox WHERE payload->>'action' = 'WORKING_HOURS_UPDATED'`);
  const items = rows.map(({ payload }, index) => ({
    audit_id: payload.audit_id,
    version_no: count - index,
    occurred_at: payload.occurred_at,
    actor_role: payload.actor_role ?? null,
    items: payload.after_value?.items ?? [],
  }));
  return { items, total: count };
}
