import { createDataSource, isUuid, ROLES } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { freezeOfficeList } from '../src/lib/catalogue/office-freeze.js';

// EB15: freezes the active office list at the moment it is sent to FMS.
//   npm run freeze:offices -- --actor <super-admin-account-id>
// Refuses until PUP setup is done and every active office has a PUP- code. Not undoable: frozen IDs stay.
const at = process.argv.indexOf('--actor');
const actorId = at > -1 ? process.argv[at + 1] : undefined;
if (!isUuid(actorId)) throw new Error('Use --actor <authorized-super-admin-account-id>');
const ds = createDataSource({ ...dbOptions, synchronize: false });
await ds.initialize();
try {
  const { added, total } = await freezeOfficeList(ds, { id: actorId, role: ROLES.SUPER_ADMIN });
  console.log(`Office list frozen: ${added.length} newly frozen, ${total} frozen in total`);
} finally {
  await ds.destroy();
}
