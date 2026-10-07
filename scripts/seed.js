// Loads offices, services, first standards and checklists from a JSON file, without duplicates.
//   npm run seed -- --file seed/sample.json [--dry-run] [--actor <user-uuid>]
// Dry run validates and reports only; nothing is written. Re-running a file is safe.
import { readFile } from 'node:fs/promises';
import { getDb } from '../src/lib/data-source.js';
import { SYSTEM_ACTOR, runSeed } from '../src/lib/catalogue/seed.js';

function parseArgs(argv) {
  const args = { dryRun: false, file: null, actor: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--file') args.file = argv[(i += 1)];
    else if (argv[i] === '--actor') args.actor = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.file) throw new Error('Usage: npm run seed -- --file <path> [--dry-run] [--actor <user-uuid>]');
  return args;
}

async function main() {
  const { file, dryRun, actor } = parseArgs(process.argv.slice(2));
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  const dataSource = await getDb();
  try {
    const result = await runSeed(dataSource, data, { dryRun, actor: actor ? { ...SYSTEM_ACTOR, id: actor } : SYSTEM_ACTOR });
    console.log(dryRun ? 'DRY RUN: nothing was written.' : 'Seed finished.');
    for (const row of result.rows) {
      console.log(`  [${row.outcome.toUpperCase()}] ${row.kind}: ${row.label}${row.message ? ` - ${row.message}` : ''}`);
    }
    const c = result.counts;
    console.log(
      `${dryRun ? 'Would create' : 'Created'}: ${c.offices_created} office(s), ${c.services_created} service(s). ` +
        `Duplicates skipped: ${c.offices_duplicate} office(s), ${c.services_duplicate} service(s). Errors: ${c.errors}.`,
    );
    if (!dryRun) console.log('Audit events are in the outbox; the outbox job (or the next change) delivers them to Logs.');
    process.exitCode = c.errors ? 1 : 0;
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
