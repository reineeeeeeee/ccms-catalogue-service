import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { createTestDatabase } from 'ccms-shared/testing';
import { afterSync } from '../src/lib/after-sync.js';
import { bootstrapCatalogueData, loadReviewedSeeds } from '../src/lib/catalogue/development-bootstrap.js';
import { recodePupOffices } from '../src/lib/catalogue/recode-pup-offices.js';
import { runSeed } from '../src/lib/catalogue/seed.js';
import { entities } from '../src/lib/entities/index.js';

const oldSeedFiles = [
  'CCMS_SEED_CAMPADMIN_10062026.json',
  'CCMS_SEED_CAMPACAD_10062026.json',
  'CCMS_SEED_CAMPSAS_10062026.json',
  'CCMS_SEED_CAMPACCT_10062026.json',
];

const loadSeed = (name) => JSON.parse(readFileSync(new URL(`../seed/${name}`, import.meta.url), 'utf8'));

describe('CAMP to PUP office recode', () => {
  let testDb;
  let dataSource;
  const actor = { id: randomUUID(), role: 'super_admin' };

  before(async () => {
    testDb = await createTestDatabase({ entities, afterSync });
    dataSource = testDb.dataSource;
    for (const name of oldSeedFiles) {
      const seeded = await runSeed(dataSource, loadSeed(name), { actor });
      assert.equal(seeded.counts.errors, 0, name);
    }
  });

  after(async () => {
    await testDb?.drop();
  });

  it('rolls a dry run back, then preserves IDs, recodes 69 services and deactivates the 12 moved OSAS services', async () => {
    const beforeOffices = await dataSource.query(
      `SELECT office_id, office_code FROM offices WHERE office_code LIKE 'CAMP-%' ORDER BY office_code`,
    );
    assert.equal(beforeOffices.length, 4);
    const auditsBefore = Number((await dataSource.query('SELECT count(*)::int AS count FROM audit_outbox'))[0].count);

    const dryRun = await recodePupOffices(dataSource, { dryRun: true });
    assert.deepEqual(
      [dryRun.officesRecoded, dryRun.servicesRecoded, dryRun.servicesDeactivated],
      [4, 69, 12],
    );
    assert.equal(Number((await dataSource.query('SELECT count(*)::int AS count FROM audit_outbox'))[0].count), auditsBefore);
    assert.equal(Number((await dataSource.query(`SELECT count(*)::int AS count FROM offices WHERE office_code LIKE 'CAMP-%'`))[0].count), 4);

    const result = await recodePupOffices(dataSource, { actor });
    assert.deepEqual(
      [result.officesRecoded, result.servicesRecoded, result.servicesDeactivated],
      [4, 69, 12],
    );

    const afterOffices = await dataSource.query(
      `SELECT office_id, office_code FROM offices WHERE office_code LIKE 'PUP-%' ORDER BY office_code`,
    );
    assert.equal(afterOffices.length, 4);
    const expectedCodes = new Map([
      ['CAMP-ACAD', 'PUP-ACAD'],
      ['CAMP-ACCT', 'PUP-ACCT'],
      ['CAMP-ADMIN', 'PUP-ADMIN'],
      ['CAMP-OSAS', 'PUP-OSAS'],
    ]);
    for (const beforeOffice of beforeOffices) {
      const afterOffice = afterOffices.find((office) => office.office_id === beforeOffice.office_id);
      assert.equal(afterOffice?.office_code, expectedCodes.get(beforeOffice.office_code));
    }

    const [{ total, camp_codes: campCodes }] = await dataSource.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE service_code LIKE 'CAMP-%')::int AS camp_codes
         FROM services`,
    );
    assert.deepEqual([total, campCodes], [69, 0]);
    const [osas] = await dataSource.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE s.is_active)::int AS active,
              count(*) FILTER (WHERE NOT s.is_active)::int AS inactive
         FROM services s
         JOIN offices o ON o.office_id = s.office_id
        WHERE o.office_code = 'PUP-OSAS'`,
    );
    assert.deepEqual(osas, { total: 20, active: 8, inactive: 12 });

    const auditCounts = await dataSource.query(
      `SELECT payload->>'action' AS action, count(*)::int AS count
         FROM audit_outbox
        WHERE payload->>'actor_user_id' = $1
          AND payload->>'action' IN ('OFFICE_UPDATED', 'SERVICE_UPDATED', 'SERVICE_DEACTIVATED')
        GROUP BY payload->>'action'`,
      [actor.id],
    );
    assert.deepEqual(
      Object.fromEntries(auditCounts.map((row) => [row.action, row.count])),
      { OFFICE_UPDATED: 4, SERVICE_DEACTIVATED: 12, SERVICE_UPDATED: 69 },
    );

    const repeated = await recodePupOffices(dataSource, { actor });
    assert.deepEqual(
      [repeated.officesRecoded, repeated.servicesRecoded, repeated.servicesDeactivated],
      [0, 0, 0],
    );

    const bootstrap = await bootstrapCatalogueData(dataSource, await loadReviewedSeeds(), { actor });
    assert.equal(bootstrap.imports.reduce((sum, item) => sum + item.counts.offices_created, 0), 4);
    assert.equal(bootstrap.imports.reduce((sum, item) => sum + item.counts.services_created, 0), 20);
    const [prepared] = await dataSource.query(
      `SELECT count(DISTINCT o.office_id)::int AS offices,
              count(s.service_id)::int AS services,
              count(s.service_id) FILTER (WHERE s.is_active)::int AS active_services
         FROM offices o
         JOIN services s ON s.office_id = o.office_id
        WHERE o.office_code LIKE 'PUP-%'`,
    );
    assert.deepEqual(prepared, { offices: 8, services: 89, active_services: 77 });
  });
});
