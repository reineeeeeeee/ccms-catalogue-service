import { readFile } from 'node:fs/promises';
import { runSeed } from './seed.js';
import { recodePupOffices } from './recode-pup-offices.js';

export const REVIEWED_SEED_FILES = [
  'CCMS_SEED_ADMIN_10222026.json',
  'CCMS_SEED_ACAD_10222026.json',
  'CCMS_SEED_OSAS_10222026.json',
  'CCMS_SEED_ACCT_10222026.json',
  'CCMS_SEED_ADMREG_10212026.json',
  'CCMS_SEED_REG_10212026.json',
  'CCMS_SEED_OSFA_10212026.json',
  'CCMS_SEED_LIB_10212026.json',
];

export async function loadReviewedSeeds() {
  return Promise.all(
    REVIEWED_SEED_FILES.map(async (name) => ({
      name,
      data: JSON.parse(await readFile(new URL(`../../../seed/${name}`, import.meta.url), 'utf8')),
    })),
  );
}

function seedFailure(name, result, phase) {
  const errors = result.rows.filter((row) => row.outcome === 'error');
  const details = errors.slice(0, 5).map((row) => `${row.label}: ${row.message}`).join('; ');
  const more = errors.length > 5 ? `; plus ${errors.length - 5} more error(s)` : '';
  return new Error(`${phase} failed for ${name}: ${details}${more}`);
}

/**
 * Prepare reviewed development data after schema synchronization. Every change uses the supplied
 * Super Admin actor. Recode and seed dry-runs must all pass before any seed file is imported.
 */
export async function bootstrapCatalogueData(dataSource, seeds, { actor }) {
  const recodeDryRun = await recodePupOffices(dataSource, { dryRun: true });
  const recode = await recodePupOffices(dataSource, { actor });

  const dryRuns = [];
  for (const seed of seeds) {
    const result = await runSeed(dataSource, seed.data, { dryRun: true, actor });
    if (result.counts.errors) throw seedFailure(seed.name, result, 'Dry run');
    dryRuns.push({ name: seed.name, counts: result.counts });
  }

  const imports = [];
  for (const seed of seeds) {
    const result = await runSeed(dataSource, seed.data, { actor });
    if (result.counts.errors) throw seedFailure(seed.name, result, 'Seed import');
    imports.push({ name: seed.name, counts: result.counts });
  }

  return { recodeDryRun, recode, dryRuns, imports };
}
