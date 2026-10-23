// Recode the four previously seeded CAMP offices to PUP while preserving IDs and links.
//   npm run recode:pup-offices -- --dry-run
//   npm run recode:pup-offices -- --actor <super-admin-account-id>
import { isUuid } from 'ccms-shared';
import { recodePupOffices } from '../src/lib/catalogue/recode-pup-offices.js';
import { getDb } from '../src/lib/data-source.js';

function parseArgs(argv) {
  const args = { dryRun: false, actor: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--actor') args.actor = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.dryRun && !isUuid(args.actor)) {
    throw new Error('Usage: npm run recode:pup-offices -- --dry-run | --actor <super-admin-account-id>');
  }
  return args;
}

async function main() {
  const { dryRun, actor } = parseArgs(process.argv.slice(2));
  const dataSource = await getDb();
  try {
    const result = await recodePupOffices(dataSource, {
      dryRun,
      actor: actor ? { id: actor, role: 'super_admin' } : undefined,
    });
    for (const item of result.items) {
      if (item.outcome === 'recode') {
        const deactivated = item.services.filter((service) => service.deactivate).length;
        console.log(`  [RECODE] ${item.from} -> ${item.to}: ${item.services.length} service code(s), ${deactivated} deactivated`);
      } else if (item.outcome === 'already_recoded') {
        console.log(`  [SKIP] ${item.to}: already recoded`);
      } else {
        console.log(`  [SKIP] ${item.from}: office not found`);
      }
    }
    console.log(dryRun ? 'DRY RUN: nothing was written.' : 'Recode finished.');
    console.log(
      `${dryRun ? 'Would recode' : 'Recoded'}: ${result.officesRecoded} office(s), ${result.servicesRecoded} service code(s). ` +
        `${dryRun ? 'Would deactivate' : 'Deactivated'}: ${result.servicesDeactivated} superseded OSAS service(s).`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
