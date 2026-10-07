// The date.nager.at importer (a deployment aid). The sandbox cannot reach the real API, so every test
// injects a fetch that answers with the documented Nager.Date fields.
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { NAGER_URL, SYSTEM_ACTOR, importHolidays, mapNagerHoliday, parseArgs } from '../src/lib/calendar/holiday-import.js';
import { createException, deleteException, updateException } from '../src/lib/calendar/exceptions.js';
import { OFFICE_A, setupTestEnv } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(async () => env?.teardown());
beforeEach(async () => {
  await env.ds.query('DELETE FROM calendar_exceptions');
  await env.ds.query('DELETE FROM sync_log');
  await env.ds.query('DELETE FROM audit_outbox');
});

const nager = (date, name, extra = {}) => ({ date, localName: `${name} (local)`, name, countryCode: 'PH', fixed: true, global: true, counties: null, launchYear: null, types: ['Public'], ...extra });
const PH_2026 = [
  nager('2026-01-01', "New Year's Day"),
  nager('2026-04-09', 'Day of Valor'),
  nager('2026-06-12', 'Independence Day'),
  nager('2026-12-25', 'Christmas Day'),
];
const fakeFetch = (payload, { status = 200, calls = [] } = {}) => {
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
};
const entries = () => env.ds.query(`SELECT to_char(exception_date, 'YYYY-MM-DD') AS d, exception_type, description, office_id, is_recurring, suspended_from FROM calendar_exceptions ORDER BY exception_date`);

describe('holiday import', () => {
  it('asks Nager.Date for the Philippine holidays of the year', async () => {
    const fetchImpl = fakeFetch(PH_2026);
    await importHolidays(env.ds, { year: 2026, fetchImpl });
    assert.equal(fetchImpl.calls[0].url, 'https://date.nager.at/api/v3/PublicHolidays/2026/PH');
    assert.equal(NAGER_URL(2027), 'https://date.nager.at/api/v3/PublicHolidays/2027/PH');
  });

  it('maps each holiday to an ordinary campus-wide REGULAR_HOLIDAY (not recurring)', async () => {
    const result = await importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch(PH_2026) });
    assert.equal(result.added.length, 4);
    assert.deepEqual(await entries(), [
      { d: '2026-01-01', exception_type: 'REGULAR_HOLIDAY', description: "New Year's Day", office_id: null, is_recurring: false, suspended_from: null },
      { d: '2026-04-09', exception_type: 'REGULAR_HOLIDAY', description: 'Day of Valor', office_id: null, is_recurring: false, suspended_from: null },
      { d: '2026-06-12', exception_type: 'REGULAR_HOLIDAY', description: 'Independence Day', office_id: null, is_recurring: false, suspended_from: null },
      { d: '2026-12-25', exception_type: 'REGULAR_HOLIDAY', description: 'Christmas Day', office_id: null, is_recurring: false, suspended_from: null },
    ]);
    assert.deepEqual(mapNagerHoliday(PH_2026[0]), {
      exception_date: '2026-01-01', exception_type: 'REGULAR_HOLIDAY', description: "New Year's Day", office_id: null, suspended_from: null, is_recurring: false,
    });
  });

  it('dry run reports what it would add and writes nothing (no entries, audit or pushes)', async () => {
    const result = await importHolidays(env.ds, { year: 2026, dryRun: true, fetchImpl: fakeFetch(PH_2026) });
    assert.equal(result.dry_run, true);
    assert.equal(result.added.length, 4);
    assert.equal((await entries()).length, 0);
    assert.equal((await env.ds.query('SELECT 1 FROM sync_log')).length, 0);
    assert.equal((await env.ds.query('SELECT 1 FROM audit_outbox')).length, 0);
  });

  it('a re-run adds nothing', async () => {
    await importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch(PH_2026) });
    const second = await importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch(PH_2026) });
    assert.equal(second.added.length, 0);
    assert.equal(second.skipped.length, 4);
    assert.equal((await entries()).length, 4);
  });

  it('skips dates that already have a campus-wide entry (one-time or recurring) but not office-only ones', async () => {
    await createException(env.ds, SYSTEM_ACTOR, { exception_date: '2026-01-01', exception_type: 'REGULAR_HOLIDAY', description: 'Mine' });
    await createException(env.ds, SYSTEM_ACTOR, { exception_date: '2020-12-25', exception_type: 'REGULAR_HOLIDAY', description: 'Christmas', is_recurring: true });
    await createException(env.ds, SYSTEM_ACTOR, { exception_date: '2026-06-12', exception_type: 'LOCAL_HOLIDAY', description: 'Office only', office_id: OFFICE_A });
    const result = await importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch(PH_2026) });
    assert.deepEqual(result.skipped.map((s) => s.date), ['2026-01-01', '2026-12-25']);
    assert.deepEqual(result.added.map((s) => s.date), ['2026-04-09', '2026-06-12']);
    const kept = (await entries()).find((e) => e.d === '2026-01-01');
    assert.equal(kept.description, 'Mine', 'an existing entry is never overwritten');
  });

  it('imported rows are audited and queued for FMS and Audit like any other entry, and stay editable', async () => {
    await importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch([PH_2026[0]]) });
    const events = await env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = 'CALENDAR_EXCEPTION_ADDED'`);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.actor_user_id, SYSTEM_ACTOR.id);
    assert.equal((await env.ds.query('SELECT 1 FROM sync_log')).length, 2);

    // The Super Admin can edit an imported entry (mark it recurring) and delete it.
    const [row] = await env.ds.query('SELECT exception_id FROM calendar_exceptions');
    const edited = await updateException(env.ds, SYSTEM_ACTOR, row.exception_id, { exception_date: '2026-01-01', exception_type: 'REGULAR_HOLIDAY', description: "New Year's Day", is_recurring: true });
    assert.equal(edited.is_recurring, true);
    await deleteException(env.ds, SYSTEM_ACTOR, row.exception_id);
    assert.equal((await entries()).length, 0);
  });

  it('honours the actor it is given', async () => {
    const actor = { id: '7b2d6c1e-8a51-4b53-9a31-0a6f2d6b9e11', role: 'super_admin' };
    await importHolidays(env.ds, { year: 2026, actor, fetchImpl: fakeFetch([PH_2026[0]]) });
    const [event] = await env.ds.query(`SELECT payload FROM audit_outbox`);
    assert.equal(event.payload.actor_user_id, actor.id);
  });

  it('ignores entries with an invalid date and fails clearly on a bad response', async () => {
    const result = await importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch([nager('2026-02-30', 'Bad'), { name: 'No date' }, PH_2026[1]]) });
    assert.equal(result.added.length, 1);
    assert.equal(result.invalid.length, 2);
    await assert.rejects(importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch({}, { status: 500 }) }), /500/);
    await assert.rejects(importHolidays(env.ds, { year: 2026, fetchImpl: fakeFetch({ not: 'a list' }) }), /unexpected response/);
    await assert.rejects(importHolidays(env.ds, { year: 26, fetchImpl: fakeFetch([]) }), /four-digit year/);
    await assert.rejects(importHolidays(env.ds, { year: 2026, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND date.nager.at'); } }), /ENOTFOUND/);
  });

  it('parses the command line', () => {
    assert.deepEqual(parseArgs(['--year', '2026']), { year: 2026, dryRun: false, actor: null });
    assert.deepEqual(parseArgs(['--year=2027', '--dry-run']), { year: 2027, dryRun: true, actor: null });
    assert.deepEqual(parseArgs(['--dry-run', '--year', '2026', '--actor', 'abc']), { year: 2026, dryRun: true, actor: 'abc' });
    assert.throws(() => parseArgs([]), /Usage/);
    assert.throws(() => parseArgs(['--year', 'abc']), /Usage/);
    assert.throws(() => parseArgs(['--year', '2026', '--bogus']), /Unknown option/);
  });
});
