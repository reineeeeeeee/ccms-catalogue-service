import { Errors, recordAudit } from 'ccms-shared';
import { MSG, lockCalendar, newId, requireDate } from './calendar-rules.js';
import { TermDate } from '../entities/index.js';
import { kickOutbox } from '../outbox.js';
import { kickSync } from '../outbox.js';
import { enqueueSync } from './sync.js';

export function toTermDto(row) {
  return {
    term_id: row.termId,
    term_name: row.termName,
    start_date: row.startDate,
    end_date: row.endDate,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function parseTermInput(body) {
  const details = {};
  const termName = typeof body.term_name === 'string' ? body.term_name.trim() : '';
  if (!termName) details.term_name = 'Term name is required';
  else if (termName.length > 100) details.term_name = 'Term name must be 100 characters or fewer';
  const startDate = requireDate(body.start_date, 'start_date', 'Start date', details);
  const endDate = requireDate(body.end_date, 'end_date', 'End date', details);
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  if (endDate <= startDate) {
    throw Errors.validation(MSG.TERM_END_AFTER_START, { end_date: MSG.TERM_END_AFTER_START });
  }
  return { termName, startDate, endDate };
}

const overlapError = () => Errors.conflict(MSG.TERM_OVERLAP, 'TERM_OVERLAP');

async function assertNoOverlap(manager, { startDate, endDate }, exceptId = null) {
  // End dates are inclusive: terms that share even one day overlap.
  const qb = manager
    .getRepository(TermDate)
    .createQueryBuilder('t')
    .where('t.startDate <= :endDate AND t.endDate >= :startDate', { startDate, endDate });
  if (exceptId) qb.andWhere('t.termId <> :exceptId', { exceptId });
  if ((await qb.getCount()) > 0) throw overlapError();
}

const isExclusionViolation = (err) => (err?.code ?? err?.driverError?.code) === '23P01';

function audit(manager, actor, action, before, after, ipAddress) {
  const term = after ?? before;
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'term_date',
    entityId: term.term_id,
    officeId: null,
    before,
    after,
    ipAddress,
  });
}

async function findOrFail(manager, id) {
  const row = await manager.getRepository(TermDate).findOneBy({ termId: id });
  if (!row) throw Errors.notFound('Term not found', 'TERM_NOT_FOUND');
  return row;
}

export async function listTerms(dataSource) {
  const rows = await dataSource.getRepository(TermDate).find({ order: { startDate: 'ASC' } });
  return rows.map(toTermDto);
}

export async function createTerm(dataSource, actor, body, { ipAddress } = {}) {
  const input = parseTermInput(body);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      await lockCalendar(manager);
      await assertNoOverlap(manager, input);
      const termId = newId();
      await manager.getRepository(TermDate).insert({ termId, ...input });
      const created = toTermDto(await findOrFail(manager, termId));
      await audit(manager, actor, 'TERM_ADDED', null, created, ipAddress);
      await enqueueSync(manager, {
        eventType: 'TERM_ADDED',
        entityType: 'term_date',
        entityId: termId,
        data: { term: created },
        consumers: ['AUDIT'], // FMS receives calendar data only; terms go to Audit
      });
      return created;
    });
    kickOutbox();
    kickSync();
    return dto;
  } catch (err) {
    if (isExclusionViolation(err)) throw overlapError();
    throw err;
  }
}

export async function updateTerm(dataSource, actor, id, body, { ipAddress } = {}) {
  const input = parseTermInput(body);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      await lockCalendar(manager);
      const before = toTermDto(await findOrFail(manager, id));
      if (before.term_name === input.termName && before.start_date === input.startDate && before.end_date === input.endDate) {
        return before;
      }
      await assertNoOverlap(manager, input, id);
      await manager.getRepository(TermDate).update({ termId: id }, input);
      const after = toTermDto(await findOrFail(manager, id));
      await audit(manager, actor, 'TERM_UPDATED', before, after, ipAddress);
      await enqueueSync(manager, {
        eventType: 'TERM_UPDATED',
        entityType: 'term_date',
        entityId: id,
        data: { term: after, previous: before },
        consumers: ['AUDIT'],
      });
      return after;
    });
    kickOutbox();
    kickSync();
    return dto;
  } catch (err) {
    if (isExclusionViolation(err)) throw overlapError();
    throw err;
  }
}
