// TT1: the working-time engine suite (and the engine endpoints) must give identical results whatever the
// server clock says. This runs them again with the process time zone set to UTC, and to a zone with
// daylight saving (America/Los_Angeles), so a hidden dependency on the server's local time fails here.
import { spawnSync } from 'node:child_process';

const RUNS = [
  { TZ: 'UTC', expectOffset: '0' },
  { TZ: 'America/Los_Angeles', expectOffset: '480' }, // January: UTC-08:00
];
const FILES = ['test/calendar-engine/*.test.js', 'test/calendar-engine-api.test.js'];

let failed = false;
for (const { TZ, expectOffset } of RUNS) {
  console.log(`\n=== engine suite with TZ=${TZ} ===`);
  const result = spawnSync(process.execPath, ['--test', ...FILES], {
    stdio: 'inherit',
    env: { ...process.env, TZ, CCMS_EXPECT_TZ_OFFSET: expectOffset },
  });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
