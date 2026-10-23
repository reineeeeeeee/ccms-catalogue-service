// Development-only database preparation run automatically by npm's predev lifecycle hook.
import { createDataSource, getDataSource, isUuid } from 'ccms-shared';
import { bootstrapCatalogueData, loadReviewedSeeds } from '../src/lib/catalogue/development-bootstrap.js';
import { migrateSeedingModel } from '../src/lib/catalogue/seeding-model-migration.js';
import { dbOptions } from '../src/lib/data-source.js';

const actorId = process.env.CCMS_SEED_ACTOR_ID?.trim();
if (process.env.NODE_ENV === 'production') {
  throw new Error('Development bootstrap is disabled when NODE_ENV=production');
}
if (!isUuid(actorId)) {
  throw new Error('CCMS_SEED_ACTOR_ID must be the account_id UUID of an active Super Admin in Identity');
}
const actor = { id: actorId, role: 'super_admin' };

// Preserve unambiguous values from an older schema before TypeORM synchronizes it.
const migrationSource = createDataSource({ ...dbOptions, synchronize: false });
await migrationSource.initialize();
try {
  await migrateSeedingModel(migrationSource);
} finally {
  await migrationSource.destroy();
}

const dataSource = await getDataSource({ ...dbOptions, synchronize: true });
try {
  const seeds = await loadReviewedSeeds();
  const result = await bootstrapCatalogueData(dataSource, seeds, { actor });

  const action = result.recode.officesRecoded ? 'Recoded' : 'Recode unchanged';
  console.log(
    `${action}: ${result.recode.officesRecoded} office(s), ${result.recode.servicesRecoded} service code(s), ` +
      `${result.recode.servicesDeactivated} OSAS service(s) deactivated.`,
  );
  for (const item of result.imports) {
    const counts = item.counts;
    console.log(
      `Seed ${item.name}: created ${counts.offices_created} office(s) and ${counts.services_created} service(s); ` +
        `skipped ${counts.offices_duplicate} office(s) and ${counts.services_duplicate} service(s).`,
    );
  }
  console.log('Development database bootstrap complete.');
} finally {
  await dataSource.destroy();
}
