// Deployment aid, not a feature: imports the Philippine public holidays of one year from
// https://date.nager.at/api/v3/PublicHolidays/{year}/PH as ordinary campus-wide REGULAR_HOLIDAY
// entries (not recurring; the Super Admin can edit, delete or mark them recurring afterwards).
//
//   npm run seed:holidays -- --year 2026 [--years 5] [--dry-run] [--actor <super admin user id>]
//   --years 5 imports 5 years in a row, starting at --year (2026, 2027, 2028, 2029, 2030).
//
// Dates that already have a campus-wide entry are skipped, so running it again adds nothing.
// --dry-run shows what would be added and writes nothing.
import { getDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { SYSTEM_ACTOR, importHolidays, parseArgs } from '../src/lib/calendar/holiday-import.js';

async function main() {
  const argv = process.argv.slice(2);
  // --years N is handled here; the rest goes to the usual argument parser, one year at a time.
  const at = argv.indexOf('--years');
  const years = at === -1 ? 1 : Number(argv[at + 1]);
  if (!Number.isInteger(years) || years < 1 || years > 10) throw new Error('--years must be a whole number from 1 to 10');
  const rest = at === -1 ? argv : argv.filter((_, i) => i !== at && i !== at + 1);
  const first = parseArgs(rest);
  const actor = first.actor ? { id: first.actor, role: 'super_admin' } : SYSTEM_ACTOR;
  const dataSource = await getDataSource(dbOptions);
  try {
    for (let i = 0; i < years; i += 1) {
      const year = first.year + i;
      console.log(`--- ${year} ---`);
      const result = await importHolidays(dataSource, { year, dryRun: first.dryRun, actor, log: console.log });
      console.log(
        `${result.dry_run ? 'Dry run: ' : ''}${result.fetched} holidays fetched, ${result.added.length} ${result.dry_run ? 'would be added' : 'added'}, ${result.skipped.length} skipped` +
          (result.invalid.length ? `, ${result.invalid.length} ignored (invalid date)` : ''),
      );
    }
    if (!first.dryRun) console.log('The calendar sync job pushes the new entries to FMS and Audit; their audit events go out with the outbox job.');
  } finally {
    await dataSource.destroy();
    globalThis.__ccmsDataSource = undefined;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});