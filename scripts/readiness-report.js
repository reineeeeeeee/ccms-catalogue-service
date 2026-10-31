import { createDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { activeOffices, readinessFailed, runReadiness } from '../src/lib/readiness.js';

// EB15 readiness report (read-only). Exit code 1 when any check FAILs.
//   npm run readiness                 print the report
//   npm run readiness -- --offices    print the active offices (ID, code, name) as CSV for FMS (EB2) and stop
const ds = createDataSource({ ...dbOptions, synchronize: false });
await ds.initialize();
try {
  if (process.argv.includes('--offices')) {
    const rows = await activeOffices(ds);
    console.log('office_id,office_code,office_name');
    for (const r of rows) console.log([r.office_id, r.office_code, `"${String(r.office_name).replaceAll('"', '""')}"`].join(','));
  } else {
    const checks = await runReadiness(ds);
    for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.label}${c.detail ? `  -> ${c.detail}` : ''}`);
    const failed = checks.filter((c) => c.status === 'FAIL').length;
    console.log(`\n${checks.length} checks, ${failed} failed`);
    if (readinessFailed(checks)) process.exitCode = 1;
  }
} finally {
  await ds.destroy();
}
