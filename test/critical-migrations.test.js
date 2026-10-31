import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createTestDatabase } from 'ccms-shared/testing';
import { migrateSprint4Core } from '../src/lib/migrations/sprint4-critical.js';

describe('Sprint 4 migration from an existing legacy schema', () => {
  it('preserves IDs, codes and calendar data; defaults old rows to BOTH/SUSPENDED; runs twice safely', async () => {
    const database = await createTestDatabase({ entities: [] });
    const ds = database.dataSource;
    try {
      await ds.query('CREATE TABLE services (service_id uuid PRIMARY KEY, service_code text NOT NULL)');
      await ds.query('CREATE TABLE calendar_exceptions (exception_id uuid PRIMARY KEY, exception_date date, description text, office_id uuid, suspended_from text)');
      const serviceId = randomUUID(), calendarId = randomUUID();
      await ds.query("INSERT INTO services VALUES ($1, 'PUP-OSAS-TOR-087')", [serviceId]);
      await ds.query("INSERT INTO calendar_exceptions VALUES ($1, '2026-10-07', 'Original announcement')", [calendarId]);
      await migrateSprint4Core(ds); await migrateSprint4Core(ds);
      assert.deepEqual(await ds.query('SELECT * FROM services'), [{ service_id: serviceId, service_code: 'PUP-OSAS-TOR-087' }]);
      assert.deepEqual(await ds.query('SELECT exception_id, exception_date::text, description, applies_to, class_mode, revision, suspended_until, removed_at FROM calendar_exceptions'), [{ exception_id: calendarId, exception_date: '2026-10-07', description: 'Original announcement', applies_to: 'BOTH', class_mode: 'SUSPENDED', revision: 1, suspended_until: null, removed_at: null }]);
      await assert.rejects(ds.query("INSERT INTO catalogue_settings (id, institution_code) VALUES (2, 'OTHER')"), (e) => e.code === '23514');
      await assert.rejects(ds.query("UPDATE catalogue_settings SET institution_code='bad-code'"), (e) => e.code === '23514');
    } finally { await database.drop(); }
  });
});
