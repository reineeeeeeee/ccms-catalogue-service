import { Errors, assertOfficeAccess, officeFilter, isUniqueViolation, isValidManilaDate, recordAudit } from 'ccms-shared';
import { IsNull } from 'typeorm';
import { EXCEPTION_TYPES, MSG, isHHMM, lockCalendar, newId, optionalText, parseOptionalUuid, requireDate } from './calendar-rules.js';
import { CalendarException } from '../entities/index.js';
import { entriesConflict, occurrencesInRange } from './engine/recurrence.js';
import { timeToMinutes, weekdayOfDayIndex, dayIndexOfDate } from './engine/working-time.js';
import { kickOutbox } from '../outbox.js';
import { readSchedule } from './schedule.js';
import { kickSync } from '../outbox.js';
import { enqueueSync } from './sync.js';

const UNIQUE_INDEX = 'calendar_exceptions_scope_date_uq';

export function toExceptionDto(row) {
  return {
    exception_id: row.exceptionId,
    exception_date: row.exceptionDate,
    exception_type: row.exceptionType,
    description: row.description ?? '',
    office_id: row.officeId ?? null,
    suspended_from: row.suspendedFrom ?? null,
    is_recurring: row.isRecurring,
    created_at: row.createdAt,
  };
}

/** The engine's view of an entry (snake_case, plain values). */
export const toEngineEntry = toExceptionDto;

/** Validates the body of POST /exceptions and PUT /exceptions/:id. */
export function parseExceptionInput(body) {
  const details = {};
  const exceptionDate = requireDate(body.exception_date, 'exception_date', 'Date', details);

  const exceptionType = body.exception_type;
  if (!EXCEPTION_TYPES.includes(exceptionType)) {
    details.exception_type = `Type must be one of ${EXCEPTION_TYPES.join(', ')}`;
  }

  let description = optionalText(body.description);
  if (description === undefined) details.description = 'Description must be text';
  else if (description && description.length > 200) details.description = 'Description must be 200 characters or fewer';
  description = description ?? '';

  let isRecurring = false;
  if (body.is_recurring !== undefined && body.is_recurring !== null) {
    if (typeof body.is_recurring !== 'boolean') details.is_recurring = 'is_recurring must be true or false';
    else isRecurring = body.is_recurring;
  }

  const suspendedFrom = optionalText(body.suspended_from);
  if (suspendedFrom === undefined || (suspendedFrom !== null && !isHHMM(suspendedFrom))) {
    details.suspended_from = 'Suspended from must be a time in 24-hour HH:MM format';
  }

  let officeId = null;
  try {
    officeId = parseOptionalUuid(body.office_id, 'office_id', 'Office');
  } catch (err) {
    Object.assign(details, err.details);
  }

  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  if (isRecurring && exceptionType === 'SUSPENSION') {
    throw Errors.validation(MSG.SUSPENSION_NOT_RECURRING, { is_recurring: MSG.SUSPENSION_NOT_RECURRING });
  }
  return { exceptionDate, exceptionType, description, officeId, suspendedFrom, isRecurring };
}

/** A suspended_from time must fall inside the working hours of that day (opening <= time < closing). */
function assertWithinWorkingHours(schedule, input) {
  if (!input.suspendedFrom) return;
  const row = schedule.find((item) => item.day_of_week === weekdayOfDayIndex(dayIndexOfDate(input.exceptionDate)));
  const at = timeToMinutes(input.suspendedFrom);
  let message = null;
  if (!row?.is_working) {
    message = 'Suspended from time must be within working hours, but that date is not a working day';
  } else if (at < timeToMinutes(row.opening_time) || at >= timeToMinutes(row.closing_time)) {
    message = `Suspended from time must be within that day's working hours (${row.opening_time} to ${row.closing_time})`;
  }
  if (message) throw Errors.validation(message, { suspended_from: message });
}

async function assertNoConflict(manager, input, exceptId = null) {
  const sameScope = await manager
    .getRepository(CalendarException)
    .find({ where: { officeId: input.officeId ?? IsNull() } });
  const candidate = { exception_date: input.exceptionDate, is_recurring: input.isRecurring, office_id: input.officeId };
  for (const row of sameScope) {
    if (row.exceptionId === exceptId) continue;
    if (entriesConflict(candidate, toEngineEntry(row))) throw Errors.conflict(MSG.ENTRY_EXISTS, 'CALENDAR_ENTRY_EXISTS');
  }
}

function audit(manager, actor, action, before, after, ipAddress) {
  const entry = after ?? before;
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'calendar_exception',
    entityId: entry.exception_id,
    officeId: entry.office_id, // null = campus-wide
    before,
    after,
    ipAddress,
  });
}

async function findOrFail(manager, id) {
  const row = await manager.getRepository(CalendarException).findOneBy({ exceptionId: id });
  if (!row) throw Errors.notFound('Calendar entry not found', 'CALENDAR_ENTRY_NOT_FOUND');
  return row;
}

const toValues = (input) => ({
  exceptionDate: input.exceptionDate,
  exceptionType: input.exceptionType,
  description: input.description,
  officeId: input.officeId,
  suspendedFrom: input.suspendedFrom,
  isRecurring: input.isRecurring,
});

export async function createException(dataSource, actor, body, { ipAddress } = {}) {
  const input = parseExceptionInput(body);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      await lockCalendar(manager);
      assertWithinWorkingHours(await readSchedule(manager), input);
      await assertNoConflict(manager, input);
      const exceptionId = newId();
      await manager.getRepository(CalendarException).insert({ exceptionId, ...toValues(input) });
      const created = toExceptionDto(await findOrFail(manager, exceptionId));
      await audit(manager, actor, 'CALENDAR_EXCEPTION_ADDED', null, created, ipAddress);
      await enqueueSync(manager, {
        eventType: 'CALENDAR_EXCEPTION_ADDED',
        entityType: 'calendar_exception',
        entityId: exceptionId,
        data: { exception: created },
      });
      return created;
    });
    kickOutbox();
    kickSync();
    return dto;
  } catch (err) {
    if (isUniqueViolation(err, UNIQUE_INDEX)) throw Errors.conflict(MSG.ENTRY_EXISTS, 'CALENDAR_ENTRY_EXISTS');
    throw err;
  }
}

export async function updateException(dataSource, actor, id, body, { ipAddress } = {}) {
  const input = parseExceptionInput(body);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      await lockCalendar(manager);
      const before = toExceptionDto(await findOrFail(manager, id));
      assertWithinWorkingHours(await readSchedule(manager), input);
      await assertNoConflict(manager, input, id);
      const unchanged =
        before.exception_date === input.exceptionDate &&
        before.exception_type === input.exceptionType &&
        before.description === input.description &&
        before.office_id === input.officeId &&
        before.suspended_from === input.suspendedFrom &&
        before.is_recurring === input.isRecurring;
      if (unchanged) return before;
      await manager.getRepository(CalendarException).update({ exceptionId: id }, toValues(input));
      const after = toExceptionDto(await findOrFail(manager, id));
      // The audit row belongs to the office the entry now applies to; a scope change is visible in before/after.
      await audit(manager, actor, 'CALENDAR_EXCEPTION_UPDATED', before, after, ipAddress);
      await enqueueSync(manager, {
        eventType: 'CALENDAR_EXCEPTION_UPDATED',
        entityType: 'calendar_exception',
        entityId: id,
        data: { exception: after, previous: before },
      });
      return after;
    });
    kickOutbox();
    kickSync();
    return dto;
  } catch (err) {
    if (isUniqueViolation(err, UNIQUE_INDEX)) throw Errors.conflict(MSG.ENTRY_EXISTS, 'CALENDAR_ENTRY_EXISTS');
    throw err;
  }
}

/** Removes an entry (recurring ones for every year). The audit keeps the removed values. */
export async function deleteException(dataSource, actor, id, { ipAddress } = {}) {
  await dataSource.transaction(async (manager) => {
    await lockCalendar(manager);
    const before = toExceptionDto(await findOrFail(manager, id));
    await manager.getRepository(CalendarException).delete({ exceptionId: id });
    await audit(manager, actor, 'CALENDAR_EXCEPTION_REMOVED', before, null, ipAddress);
    await enqueueSync(manager, {
      eventType: 'CALENDAR_EXCEPTION_REMOVED',
      entityType: 'calendar_exception',
      entityId: id,
      data: { exception: before, removed: true },
    });
  });
  kickOutbox();
  kickSync();
}

function parseDateParam(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (!isValidManilaDate(value)) {
    throw Errors.validation(`${name} must be a date (YYYY-MM-DD)`, { [name]: `${name} must be a date (YYYY-MM-DD)` });
  }
  return value;
}

/**
 * GET /exceptions?from&to&office_id&type. office_id matches that office's own entries exactly.
 * With from/to, a recurring entry is listed when it occurs at least once in the range.
 * Office Head / Office Staff see campus-wide entries and their own office's entries only.
 */
export async function listExceptions(dataSource, user, query = {}) {
  const from = parseDateParam(query.from, 'from');
  const to = parseDateParam(query.to, 'to');
  if (from && to && from > to) throw Errors.validation('from must not be after to', { from: 'from must not be after to' });
  const officeId = parseOptionalUuid(query.office_id, 'office_id', 'Office');
  const type = optionalText(query.type);
  if (type && !EXCEPTION_TYPES.includes(type)) {
    throw Errors.validation(`type must be one of ${EXCEPTION_TYPES.join(', ')}`, { type: 'Unknown type' });
  }
  if (officeId) assertOfficeAccess(user, officeId);

  const qb = dataSource.getRepository(CalendarException).createQueryBuilder('e');
  if (officeId) qb.andWhere('e.officeId = :officeId', { officeId });
  else if (officeFilter(user)) qb.andWhere('(e.officeId IS NULL OR e.officeId = :own)', { own: officeFilter(user) });
  if (type) qb.andWhere('e.exceptionType = :type', { type });
  qb.orderBy('e.exceptionDate', 'ASC').addOrderBy('e.createdAt', 'ASC');
  const rows = await qb.getMany();
  return rows
    .map(toExceptionDto)
    .filter((entry) => !(from || to) || occurrencesInRange(entry, from, to).length > 0);
}

/** Entries for the engine: campus-wide plus (when given) one office's. */
export async function loadEngineEntries(manager, officeId = null) {
  const qb = manager.getRepository(CalendarException).createQueryBuilder('e');
  if (officeId) qb.where('(e.officeId IS NULL OR e.officeId = :officeId)', { officeId });
  else qb.where('e.officeId IS NULL');
  return (await qb.getMany()).map(toEngineEntry);
}

/**
 * GET /holidays: entries effective in [from, to] for the campus and (when given) one office,
 * with recurring entries expanded per year (Feb 29 only in leap years, never before the anchor year).
 */
export async function listEffectiveHolidays(dataSource, { from, to, officeId = null }) {
  const entries = await loadEngineEntries(dataSource, officeId);
  const items = [];
  for (const entry of entries) {
    for (const date of occurrencesInRange(entry, from, to)) {
      items.push({
        date,
        exception_type: entry.exception_type,
        description: entry.description,
        office_id: entry.office_id,
        suspended_from: entry.suspended_from,
      });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.office_id ?? '').localeCompare(b.office_id ?? ''));
  return items;
}
