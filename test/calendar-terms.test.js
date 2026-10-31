import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { PUT as putRoute } from '../src/app/api/terms/[id]/route.js';
import { GET as listRoute, POST as postRoute } from '../src/app/api/terms/route.js';
import { ctx, req, setupTestEnv, tokens } from './calendar-helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(async () => env?.teardown());

const term = (term_name, start_date, end_date) => ({ term_name, start_date, end_date });
const add = async (body, token = tokens.superAdmin) => {
  const response = await postRoute(req('POST', '/terms', { token, body }));
  return { response, body: await response.json() };
};
const edit = async (id, body, token = tokens.superAdmin) => {
  const response = await putRoute(req('PUT', `/terms/${id}`, { token, body }), ctx(id));
  return { response, body: await response.json() };
};
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);

describe('academic terms (CC016)', () => {
  it('AC1: a term with its start before its end saves and is listed in date order', async () => {
    const second = await add(term('2nd Semester 2026-2027', '2027-01-11', '2027-05-28'));
    assert.equal(second.response.status, 201);
    const first = await add(term('1st Semester 2026-2027', '2026-08-17', '2026-12-18'));
    assert.equal(first.response.status, 201);
    assert.equal(first.body.term.term_name, '1st Semester 2026-2027');
    assert.equal(first.body.term.start_date, '2026-08-17');
    assert.equal(first.body.term.end_date, '2026-12-18');
    assert.ok(first.body.term.term_id);
    const list = await (await listRoute(req('GET', '/terms', { token: tokens.officeStaffA }))).json();
    assert.deepEqual(list.items.map((t) => t.term_name), ['1st Semester 2026-2027', '2nd Semester 2026-2027']);
  });

  it('AC2: an end date on or before the start date is rejected', async () => {
    for (const [start, end] of [['2028-01-10', '2028-01-10'], ['2028-01-10', '2028-01-09'], ['2028-02-01', '2027-06-01']]) {
      const { response, body } = await add(term('Bad', start, end));
      assert.equal(response.status, 400);
      assert.equal(body.error.message, 'End date must be after start date');
    }
  });

  it('AC3: overlapping dates are rejected with "Term dates overlap an existing term" (shared days count)', async () => {
    const cases = [
      ['2026-09-01', '2026-10-01'], // inside
      ['2026-08-01', '2026-08-17'], // touches the first day
      ['2026-12-18', '2027-01-10'], // touches the last day
      ['2026-06-01', '2027-06-01'], // surrounds both
      ['2026-12-01', '2027-02-01'], // spans the gap and both terms
    ];
    for (const [start, end] of cases) {
      const { response, body } = await add(term('Overlap', start, end));
      assert.equal(response.status, 409, `${start}..${end}`);
      assert.equal(body.error.message, 'Term dates overlap an existing term');
    }
    // Consecutive days do not overlap.
    assert.equal((await add(term('Summer 2026', '2026-12-19', '2027-01-10'))).response.status, 201);
    assert.equal((await add(term('Before', '2026-06-01', '2026-08-16'))).response.status, 201);
  });

  it('the database enforces no-overlap as well', async () => {
    await assert.rejects(
      env.ds.query(`INSERT INTO term_dates (term_id, term_name, start_date, end_date) VALUES ($1, 'x', '2026-09-01', '2026-09-30')`, [randomUUID()]),
      (err) => err.code === '23P01',
    );
  });

  it('AC4: an edited start date is audited (before and after) and queued for Audit only', async () => {
    const { body: created } = await add(term('Midyear 2026', '2029-06-01', '2029-07-31'));
    const id = created.term.term_id;
    await env.ds.query('DELETE FROM audit_outbox');
    await env.ds.query('DELETE FROM sync_log');
    const { response, body } = await edit(id, term('Midyear 2026', '2029-06-08', '2029-07-31'));
    assert.equal(response.status, 200);
    assert.equal(body.term.start_date, '2029-06-08');
    const [event] = (await audits('TERM_UPDATED')).map((r) => r.payload);
    assert.equal(event.entity_id, id);
    assert.equal(event.before_value.start_date, '2029-06-01');
    assert.equal(event.after_value.start_date, '2029-06-08');
    assert.equal(event.office_id, null);
    const rows = await env.ds.query('SELECT consumer_system, event_type, status FROM sync_log');
    assert.deepEqual(rows, [{ consumer_system: 'AUDIT', event_type: 'TERM_UPDATED', status: 'PENDING' }]);
    assert.equal(rows.length, 1);
  });

  it('a term can be edited into the dates it already has without clashing with itself; unchanged saves are no-ops', async () => {
    const { body: created } = await add(term('Solo', '2031-01-01', '2031-03-01'));
    const id = created.term.term_id;
    await env.ds.query('DELETE FROM audit_outbox');
    assert.equal((await edit(id, term('Solo', '2031-01-01', '2031-03-01'))).response.status, 200);
    assert.equal((await audits('TERM_UPDATED')).length, 0);
    assert.equal((await edit(id, term('Solo', '2030-12-01', '2031-04-01'))).response.status, 200);
    const clash = await edit(id, term('Solo', '2026-09-01', '2031-04-01'));
    assert.equal(clash.response.status, 409);
    assert.equal(clash.body.error.message, 'Term dates overlap an existing term');
  });

  it('audits TERM_ADDED and queues the push for Audit', async () => {
    await env.ds.query('DELETE FROM audit_outbox');
    await env.ds.query('DELETE FROM sync_log');
    const { body } = await add(term('Added', '2033-01-01', '2033-05-01'));
    const [event] = (await audits('TERM_ADDED')).map((r) => r.payload);
    assert.equal(event.entity_id, body.term.term_id);
    assert.equal(event.before_value, null);
    assert.equal(event.after_value.term_name, 'Added');
    const [row] = await env.ds.query('SELECT consumer_system, payload FROM sync_log');
    assert.equal(row.consumer_system, 'AUDIT');
    assert.equal(row.payload.data.term.term_name, 'Added');
    assert.equal(row.payload.event_type, 'TERM_ADDED');
  });

  it('validates the fields and returns 404 for an unknown term', async () => {
    const { response, body } = await add({});
    assert.equal(response.status, 400);
    assert.ok(body.error.details.term_name && body.error.details.start_date && body.error.details.end_date);
    assert.equal((await add(term('  ', '2040-01-01', '2040-02-01'))).response.status, 400);
    assert.equal((await add(term('x', '2040-02-30', '2040-03-01'))).response.status, 400);
    assert.equal((await add(term('x', '2040-01-01', '2040-3-1'))).response.status, 400);
    assert.equal((await add(term('x'.repeat(101), '2040-01-01', '2040-02-01'))).response.status, 400);
    const missing = randomUUID();
    assert.equal((await edit(missing, term('x', '2040-01-01', '2040-02-01'))).response.status, 404);
    assert.equal((await edit('nope', term('x', '2040-01-01', '2040-02-01'))).response.status, 404);
  });

  it('AC5: Office Head, Office Staff and Executive get 403 on writes; reading needs a sign-in', async () => {
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) {
      assert.equal((await add(term('Nope', '2050-01-01', '2050-02-01'), token)).response.status, 403);
      assert.equal((await edit(randomUUID(), term('Nope', '2050-01-01', '2050-02-01'), token)).response.status, 403);
      assert.equal((await listRoute(req('GET', '/terms', { token }))).status, 200);
    }
    assert.equal((await listRoute(req('GET', '/terms'))).status, 401);
    assert.equal((await postRoute(req('POST', '/terms', { body: term('x', '2050-01-01', '2050-02-01') }))).status, 401);
  });
});

runBoundarySuite({
  name: 'terms',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    { name: 'POST /terms', write: true, superAdminOnly: true, officeScoped: false, invoke: (token) => postRoute(req('POST', '/terms', { token, body: term('Boundary', '2060-01-01', '2060-02-01') })).then(async (r) => {
      if (r.status === 201) await env.ds.query(`DELETE FROM term_dates WHERE term_name = 'Boundary'`);
      return r;
    }) },
    { name: 'PUT /terms/:id', write: true, superAdminOnly: true, officeScoped: false, invoke: (token) => putRoute(req('PUT', `/terms/${randomUUID()}`, { token, body: term('x', '2060-01-01', '2060-02-01') }), ctx(randomUUID())) },
    { name: 'GET /terms', write: false, officeScoped: false, invoke: (token) => listRoute(req('GET', '/terms', { token })) },
  ],
});
