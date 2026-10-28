import { createDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { migrateSprint4Core } from '../src/lib/migrations/sprint4-critical.js';
const ds = createDataSource({ ...dbOptions, synchronize: false });
await ds.initialize();
try { await migrateSprint4Core(ds); console.log('Sprint 4 Core migration completed'); }
finally { await ds.destroy(); }
