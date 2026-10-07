import { isValidManilaDate } from 'ccms-shared';
import { CalendarException } from '../entities/index.js';
import { createException, toEngineEntry } from './exceptions.js';
import { entriesConflict } from './engine/recurrence.js';

export const NAGER_URL = (year) => `https://date.nager.at/api/v3/PublicHolidays/${year}/PH`;

/** Audit actor used when no Super Admin is named: a fixed system identity with the Super Admin role. */
export const SYSTEM_ACTOR = Object.freeze({ id: '00000000-0000-0000-0000-000000000000', role: 'super_admin' });

/** Maps one Nager.Date holiday to an ordinary campus-wide REGULAR_HOLIDAY entry (not recurring). */
export function mapNagerHoliday(holiday) {
  return {
    exception_date: holiday.date,
    exception_type: 'REGULAR_HOLIDAY',
    description: String(holiday.name ?? holiday.localName ?? '').trim().slice(0, 200),
    office_id: null,
    suspended_from: null,
    is_recurring: false,
  };
}

/**
 * Imports the Philippine public holidays of one year from date.nager.at.
 *   - each holiday becomes an ordinary campus-wide REGULAR_HOLIDAY (is_recurring false), editable by the Super Admin;
 *   - dates that already have a campus-wide entry (one-time or recurring) are skipped, so a re-run adds nothing;
 *   - dryRun reads and reports but writes nothing.
 * `fetchImpl` is injected so tests never reach the network.
 */
export async function importHolidays(dataSource, { year, dryRun = false, fetchImpl = fetch, actor = SYSTEM_ACTOR, log = () => {} }) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('year must be a four-digit year, for example 2026');
  const response = await fetchImpl(NAGER_URL(year), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`date.nager.at responded ${response.status}`);
  const holidays = await response.json();
  if (!Array.isArray(holidays)) throw new Error('date.nager.at returned an unexpected response (expected a list)');

  const campusEntries = (await dataSource.getRepository(CalendarException).find()).filter((row) => !row.officeId).map(toEngineEntry);
  const result = { year, dry_run: dryRun, fetched: holidays.length, added: [], skipped: [], invalid: [] };

  for (const holiday of holidays) {
    if (typeof holiday?.date !== 'string' || !isValidManilaDate(holiday.date)) {
      result.invalid.push(holiday?.date ?? null);
      continue;
    }
    const entry = mapNagerHoliday(holiday);
    const existing = campusEntries.find((row) => entriesConflict(row, entry));
    if (existing) {
      result.skipped.push({ date: entry.exception_date, description: entry.description });
      log(`skip ${entry.exception_date} ${entry.description} (campus-wide entry exists)`);
      continue;
    }
    if (!dryRun) {
      const created = await createException(dataSource, actor, entry);
      campusEntries.push(created);
    }
    result.added.push({ date: entry.exception_date, description: entry.description });
    log(`${dryRun ? 'would add' : 'add'} ${entry.exception_date} ${entry.description}`);
  }
  return result;
}

/** Parses `--year 2026 [--dry-run] [--actor <user id>]`. */
export function parseArgs(argv) {
  const args = { year: null, dryRun: false, actor: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--year') args.year = Number(argv[(i += 1)]);
    else if (arg.startsWith('--year=')) args.year = Number(arg.slice(7));
    else if (arg === '--actor') args.actor = argv[(i += 1)];
    else if (arg.startsWith('--actor=')) args.actor = arg.slice(8);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(args.year)) throw new Error('Usage: npm run seed:holidays -- --year 2026 [--dry-run]');
  return args;
}

