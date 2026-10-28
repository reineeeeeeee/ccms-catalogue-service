import { createDataSource, isUuid, ROLES } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { updateCatalogueSettings } from '../src/lib/catalogue/settings.js';
const actorId = process.argv[process.argv.indexOf('--actor') + 1];
if (!process.argv.includes('--actor') || !isUuid(actorId)) throw new Error('Use --actor <authorized-super-admin-account-id>');
const ds = createDataSource({ ...dbOptions, synchronize: false });
await ds.initialize();
try {
  await updateCatalogueSettings(ds, { id: actorId, role: ROLES.SUPER_ADMIN }, { institution_code: 'PUP', applies_to_enabled: true });
  console.log('PUP institution and calendar setup completed');
} finally { await ds.destroy(); }
