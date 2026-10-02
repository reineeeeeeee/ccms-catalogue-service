// Deployment aid, not a feature: imports the Philippine public holidays of one year from
// https://date.nager.at/api/v3/PublicHolidays/{year}/PH as ordinary campus-wide REGULAR_HOLIDAY
// entries (not recurring; the Super Admin can edit, delete or mark them recurring afterwards).
//
//   npm run seed:holidays -- --year 2026 [--dry-run] [--actor <super admin user id>]
//
// Dates that already have a campus-wide entry are skipped, so running it again adds nothing.
// --dry-run shows what would be added and writes nothing.
import { getDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { SYSTEM_ACTOR, importHolidays, parseArgs } from '../src/lib/holiday-import.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const actor = args.actor ? { id: args.actor, role: 'super_admin' } : SYSTEM_ACTOR;
  const dataSource = await getDataSource(dbOptions);
  try {
    const result = await importHolidays(dataSource, { year: args.year, dryRun: args.dryRun, actor, log: console.log });
    console.log(
      `${result.dry_run ? 'Dry run: ' : ''}${result.fetched} holidays fetched, ${result.added.length} ${result.dry_run ? 'would be added' : 'added'}, ${result.skipped.length} skipped` +
        (result.invalid.length ? `, ${result.invalid.length} ignored (invalid date)` : ''),
    );
    if (!result.dry_run && result.added.length) {
      console.log('The running Core service (Calendar half) pushes the new entries to FMS and Audit and sends their audit events.');
    }
  } finally {
    await dataSource.destroy();
    globalThis.__ccmsDataSource = undefined;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
