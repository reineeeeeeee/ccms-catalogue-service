import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { OutboxEvent, dispatchOutbox, recordAudit } from '../src/index.js';
import { createTestDatabase } from '../src/testing/index.js';

let testDb;
let ds;
before(async () => {
  testDb = await createTestDatabase({ entities: [OutboxEvent] });
  ds = testDb.dataSource;
});
after(() => testDb?.drop());

const event = (n) => ({
  actor: { id: '33333333-3333-4333-8333-333333333333', role: 'super_admin' },
  action: 'ACCOUNT_CREATED',
  entityType: 'account',
  entityId: `acc-${n}`,
  after: { n },
});

const byEntity = (id) => ds.query(`SELECT * FROM audit_outbox WHERE payload->>'entity_id' = $1`, [id]);

describe('audit outbox (TT5)', () => {
  it('creates the audit_outbox table automatically from the entity', async () => {
    const rows = await ds.query(`SELECT to_regclass('public.audit_outbox') AS t`);
    assert.equal(rows[0].t, 'audit_outbox');
  });

  it('writes the event in the same transaction as the change', async () => {
    await assert.rejects(
      ds.transaction(async (manager) => {
        await recordAudit(manager, event('rolled-back'));
        throw new Error('business change failed');
      }),
    );
    assert.equal((await byEntity('acc-rolled-back')).length, 0, 'no event may exist for a change that did not commit');

    await ds.transaction((manager) => recordAudit(manager, event('committed')));
    const rows = await byEntity('acc-committed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.action, 'ACCOUNT_CREATED');
  });

  it('keeps events while Logs is down and delivers them once, with the same audit_id, when it is back', async () => {
    const auditId = await ds.transaction((manager) => recordAudit(manager, event('outage')));
    const received = new Map();
    let logsUp = false;
    const fakeLogs = async (_url, init) => {
      if (!logsUp) throw new Error('connect ECONNREFUSED');
      assert.equal(init.headers['x-service-key'], 'key');
      const body = JSON.parse(init.body);
      const duplicate = received.has(body.audit_id);
      received.set(body.audit_id, body);
      return new Response(JSON.stringify({ duplicate }), { status: duplicate ? 200 : 201 });
    };
    const opts = { logsUrl: 'http://logs.test/api', serviceKey: 'key', fetchImpl: fakeLogs };

    const down = await dispatchOutbox(ds, opts);
    assert.ok(down.failed >= 1);
    assert.equal(received.size, 0);
    const [failedRow] = await ds.query('SELECT sent_at, attempts, last_error FROM audit_outbox WHERE audit_id = $1', [auditId]);
    assert.equal(failedRow.sent_at, null);
    assert.match(failedRow.last_error, /ECONNREFUSED/);

    // Retries are backed off; make the rows due again as if time passed.
    await ds.query(`UPDATE audit_outbox SET next_attempt_at = now() WHERE sent_at IS NULL`);
    logsUp = true;
    const up = await dispatchOutbox(ds, opts);
    assert.ok(up.sent >= 1);
    assert.ok(received.has(auditId));

    const [sentRow] = await ds.query('SELECT sent_at FROM audit_outbox WHERE audit_id = $1', [auditId]);
    assert.ok(sentRow.sent_at);
  });

  it('does not resend events already sent, and an event recorded twice with one audit_id is stored once', async () => {
    const auditId = await ds.transaction((manager) => recordAudit(manager, event('dupe')));
    const seen = [];
    const fakeLogs = async (_url, init) => {
      seen.push(JSON.parse(init.body).audit_id);
      return new Response('{}', { status: 201 });
    };
    const opts = { logsUrl: 'http://logs.test/api', serviceKey: 'key', fetchImpl: fakeLogs };
    await dispatchOutbox(ds, opts);
    await dispatchOutbox(ds, opts);
    assert.equal(seen.filter((id) => id === auditId).length, 1);

    const fixed = '44444444-4444-4444-8444-444444444444';
    await ds.transaction((manager) => recordAudit(manager, { ...event('dupe2'), auditId: fixed }));
    await ds.transaction((manager) => recordAudit(manager, { ...event('dupe2'), auditId: fixed }));
    const rows = await ds.query('SELECT 1 FROM audit_outbox WHERE audit_id = $1', [fixed]);
    assert.equal(rows.length, 1);
  });
});
