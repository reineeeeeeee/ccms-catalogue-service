// Creates/updates this service's tables from its TypeORM entities without starting the app.
// The app does the same on start, so this is only for setting up a database ahead of time.
import { createDataSource, getDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { migrateSeedingModel } from '../src/lib/catalogue/seeding-model-migration.js';

// Convert unambiguous old Catalogue fields before TypeORM compares the old and new schemas. Scope
// deliberately stops for manual classification because INTERNAL/EXTERNAL cannot be inferred.
const migrationSource = createDataSource({ ...dbOptions, synchronize: false });
await migrationSource.initialize();
try {
  await migrateSeedingModel(migrationSource);
} finally {
  await migrationSource.destroy();
}

// Always synchronise here after the data-preserving preparation: this connection owns the schema.
const dataSource = await getDataSource({ ...dbOptions, synchronize: true });
const tables = await dataSource.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
);
console.log(`Database ready. Tables: ${tables.map((t) => t.table_name).join(', ') || '(none)'}`);
await dataSource.destroy();
