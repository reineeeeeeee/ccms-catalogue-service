import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { activeOffices, readinessFailed, runReadiness } from '../src/lib/readiness.js';
import { setupTestEnv } from './calendar-helpers.js';

let env;
before(async () => { env = await setupTestEnv(); });
after(async () => env?.teardown());
const byId = (checks, id) => checks.find((c) => c.id === id);

describe('EB15 readiness report', () => {
  it('passes on a clean database and changes nothing', async () => {
    await env.ds.query(`INSERT INTO offices (office_id, office_code, office_name) VALUES (gen_random_uuid(), 'PUP-OSAS', 'Student Affairs')`);
    const checks = await runReadiness(env.ds);
    assert.equal(readinessFailed(checks), false, JSON.stringify(checks.filter((c) => c.status === 'FAIL')));
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM calendar_exceptions'))[0].n, 0);
    assert.equal((await activeOffices(env.ds)).length, 1);
  });

  it('flags a CAMP- code, an inactive office stays INFO, and a one-office class entry (old data) fails', async () => {
    await env.ds.query(`INSERT INTO offices (office_id, office_code, office_name, is_active) VALUES (gen_random_uuid(), 'CAMP-ACAD', 'Old', true)`);
    await env.ds.query(`ALTER TABLE calendar_exceptions DROP CONSTRAINT calendar_exceptions_office_work_ck`);
    await env.ds.query(`INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, description, is_recurring, office_id, applies_to, class_mode) VALUES (gen_random_uuid(), '2026-10-07', 'REGULAR_HOLIDAY', 'x', false, gen_random_uuid(), 'BOTH', 'SUSPENDED')`);
    const checks = await runReadiness(env.ds);
    assert.equal(byId(checks, 'offices.no_camp').status, 'FAIL');
    assert.equal(byId(checks, 'offices.pup_prefix').status, 'FAIL');
    assert.equal(byId(checks, 'calendar.office_work_only').status, 'FAIL');
    assert.equal(byId(checks, 'calendar.part_day_complete').status, 'PASS');
  });
});
