import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTestDatabase } from 'ccms-shared/testing';
import { afterSync } from '../src/lib/after-sync.js';
import { bootstrapCatalogueData, loadReviewedSeeds } from '../src/lib/catalogue/development-bootstrap.js';
import { entities } from '../src/lib/entities/index.js';

describe('automatic development bootstrap on a fresh database', () => {
  let testDb;
  let dataSource;
  let seeds;
  const actor = { id: randomUUID(), role: 'super_admin' };

  before(async () => {
    testDb = await createTestDatabase({ entities, afterSync });
    dataSource = testDb.dataSource;
    seeds = await loadReviewedSeeds();
  });

  after(async () => {
    await testDb?.drop();
  });

  it('loads 8 offices and 77 services once, then skips every row on a rerun', async () => {
    const first = await bootstrapCatalogueData(dataSource, seeds, { actor });
    assert.equal(first.imports.reduce((sum, item) => sum + item.counts.offices_created, 0), 8);
    assert.equal(first.imports.reduce((sum, item) => sum + item.counts.services_created, 0), 77);
    assert.ok(first.imports.every((item) => item.counts.errors === 0));

    const [counts] = await dataSource.query(
      `SELECT count(DISTINCT o.office_id)::int AS offices,
              count(s.service_id)::int AS services,
              count(s.service_id) FILTER (WHERE s.is_active)::int AS active_services
         FROM offices o
         JOIN services s ON s.office_id = o.office_id
        WHERE o.office_code LIKE 'PUP-%'`,
    );
    assert.deepEqual(counts, { offices: 8, services: 77, active_services: 77 });

    const repeated = await bootstrapCatalogueData(dataSource, seeds, { actor });
    assert.equal(repeated.recode.officesRecoded, 0);
    assert.equal(repeated.imports.reduce((sum, item) => sum + item.counts.offices_created, 0), 0);
    assert.equal(repeated.imports.reduce((sum, item) => sum + item.counts.services_created, 0), 0);
    assert.equal(repeated.imports.reduce((sum, item) => sum + item.counts.offices_duplicate, 0), 8);
    assert.equal(repeated.imports.reduce((sum, item) => sum + item.counts.services_duplicate, 0), 77);
  });
});
