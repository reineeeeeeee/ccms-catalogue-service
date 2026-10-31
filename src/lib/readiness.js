import { randomUUID } from 'node:crypto';

// EB15: read-only readiness checks for the data FMS and SMS depend on. Nothing here changes data: the constraint probes
// run inside a transaction that is always rolled back. Each check is { id, label, status: PASS | FAIL | INFO, detail }.
// INFO means "a person must look at this" (for example the terms the PM compares with the FMS range).

const result = (id, label, status, detail = '') => ({ id, label, status, detail });
const ok = (rows) => (rows.length ? 'FAIL' : 'PASS');
const list = (rows, pick) => rows.map(pick).join('; ');

/** Active offices as FMS needs them (EB2): ID, code, name. */
export const activeOffices = (ds) =>
  ds.query('SELECT office_id, office_code, office_name FROM offices WHERE is_active = true ORDER BY office_code');

const ROLLBACK = Symbol('rollback');

/** Runs one statement in a transaction that is always rolled back; true when the database refused it. */
async function expectRejected(ds, sql, params = []) {
  let rejected = false;
  try {
    await ds.transaction(async (manager) => {
      try {
        await manager.query(sql, params);
      } catch {
        rejected = true;
      }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return rejected;
}

async function offices(ds) {
  const checks = [];
  const all = await ds.query('SELECT office_id, office_code, office_name, is_active FROM offices ORDER BY office_code');
  const active = all.filter((o) => o.is_active);
  const inactive = all.filter((o) => !o.is_active);
  checks.push(result('offices.active_count', 'Active offices', 'INFO', `${active.length} active, ${inactive.length} inactive`));
  const notPup = active.filter((o) => !/^PUP-/.test(o.office_code));
  checks.push(result('offices.pup_prefix', 'Every active office code starts with PUP-', ok(notPup), list(notPup, (o) => o.office_code)));
  const camp = all.filter((o) => /^CAMP-/i.test(o.office_code));
  checks.push(result('offices.no_camp', 'No office code starts with CAMP-', ok(camp), list(camp, (o) => `${o.office_code}${o.is_active ? '' : ' (inactive)'}`)));
  const tooLong = all.filter((o) => o.office_code.length > 20);
  checks.push(result('offices.code_length', 'Office codes are at most 20 characters', ok(tooLong), list(tooLong, (o) => o.office_code)));
  const dup = await ds.query('SELECT lower(office_code) AS code, count(*)::int AS n FROM offices GROUP BY 1 HAVING count(*) > 1');
  checks.push(result('offices.unique_ci', 'Office codes are unique ignoring letter case', ok(dup), list(dup, (d) => d.code)));
  checks.push(result('offices.inactive_marked', 'Inactive offices (they must be marked inactive for FMS)', 'INFO', list(inactive, (o) => o.office_code) || 'none'));
  return checks;
}

/** Reads the CSV written by `npm run readiness -- --offices` (office_id,office_code,"office_name"). */
export function parseOfficeBaseline(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const m = /^([^,]+),([^,]*),(.*)$/.exec(line);
    if (m) rows.push({ office_id: m[1].trim(), office_code: m[2].trim() });
  }
  return rows;
}

/**
 * EB15: office IDs must not change when the office codes are re-coded (PUP- prefix). Compares a saved export (taken before
 * the re-coding) with the database now: every saved ID must still exist, and a saved code must not have moved to a new ID
 * (that would mean the office was re-created instead of re-coded). Re-coded offices are listed as INFO.
 */
export async function officeBaseline(ds, baseline) {
  const now = await ds.query('SELECT office_id, office_code FROM offices');
  const byId = new Map(now.map((o) => [o.office_id, o.office_code]));
  const idByCode = new Map(now.map((o) => [o.office_code.toLowerCase(), o.office_id]));
  const missing = baseline.filter((b) => !byId.has(b.office_id));
  const reused = baseline.filter((b) => !byId.has(b.office_id) && idByCode.has(b.office_code.toLowerCase()));
  const recoded = baseline.filter((b) => byId.has(b.office_id) && byId.get(b.office_id) !== b.office_code);
  return [
    result('offices.baseline_ids', 'Every office ID in the saved export still exists', ok(missing), list(missing, (b) => `${b.office_id} (${b.office_code})`)),
    result('offices.baseline_not_recreated', 'No saved office code now belongs to a different ID', ok(reused), list(reused, (b) => `${b.office_code} -> ${idByCode.get(b.office_code.toLowerCase())}`)),
    result('offices.baseline_recoded', 'Offices whose code changed with the same ID', 'INFO', list(recoded, (b) => `${b.office_code} -> ${byId.get(b.office_id)}`) || 'none'),
  ];
}

/** EB15: the office list given to FMS is frozen (see migrateOfficeFreeze). Read-only: the probes are rolled back. */
async function freeze(ds) {
  const frozen = await ds.query('SELECT office_id, office_code FROM office_list_freeze');
  const checks = [result('offices.frozen_count', 'Offices in the frozen list sent to FMS', 'INFO', frozen.length ? `${frozen.length} frozen` : 'not frozen yet')];
  const missing = await ds.query('SELECT f.office_id, f.office_code FROM office_list_freeze f LEFT JOIN offices o ON o.office_id = f.office_id WHERE o.office_id IS NULL');
  checks.push(result('offices.frozen_exist', 'Every frozen office ID still exists', ok(missing), list(missing, (m) => `${m.office_id} (${m.office_code})`)));
  const trigger = (await ds.query("SELECT 1 FROM pg_trigger WHERE tgname = 'offices_frozen_guard'")).length > 0;
  checks.push(result('constraints.frozen_guard', 'Frozen office IDs are protected by a trigger', trigger ? 'PASS' : 'FAIL'));
  if (frozen.length) {
    const target = frozen[0].office_id;
    checks.push(result('probe.frozen_id_change', 'Database refuses to change a frozen office ID', (await expectRejected(ds, 'UPDATE offices SET office_id = gen_random_uuid() WHERE office_id = $1', [target])) ? 'PASS' : 'FAIL'));
    checks.push(result('probe.frozen_delete', 'Database refuses to delete a frozen office', (await expectRejected(ds, 'DELETE FROM offices WHERE office_id = $1', [target])) ? 'PASS' : 'FAIL'));
  }
  return checks;
}

async function calendar(ds) {
  const checks = [];
  const bad = await ds.query(
    `SELECT exception_id FROM calendar_exceptions
      WHERE removed_at IS NULL AND NOT (
        (applies_to = 'WORK' AND class_mode IS NULL) OR
        (applies_to IN ('CLASSES','BOTH') AND class_mode IN ('SUSPENDED','ONLINE')))`,
  );
  checks.push(result('calendar.applies_class_mode', 'applies_to and class_mode combinations are valid', ok(bad), list(bad, (r) => r.exception_id)));
  const office = await ds.query(`SELECT exception_id, exception_date FROM calendar_exceptions WHERE removed_at IS NULL AND office_id IS NOT NULL AND applies_to <> 'WORK'`);
  checks.push(result('calendar.office_work_only', 'No one-office entry affects classes (C42)', ok(office), list(office, (r) => `${r.exception_id} (${r.exception_date})`)));
  const partDay = await ds.query(
    `SELECT exception_id, exception_date FROM calendar_exceptions
      WHERE removed_at IS NULL AND suspended_from IS NOT NULL AND suspended_until IS NULL`,
  );
  checks.push(result('calendar.part_day_complete', 'Every part-day entry has a start and an end time', ok(partDay), list(partDay, (r) => `${r.exception_id} (${r.exception_date})`)));
  const noRevision = await ds.query('SELECT exception_id FROM calendar_exceptions WHERE revision IS NULL OR revision < 1');
  checks.push(result('calendar.revision', 'Every entry has a revision of 1 or more', ok(noRevision), list(noRevision, (r) => r.exception_id)));
  const [tomb] = await ds.query('SELECT count(*)::int AS n FROM calendar_exceptions WHERE removed_at IS NOT NULL');
  checks.push(result('calendar.tombstones', 'Removed entries are kept as tombstones', 'INFO', `${tomb.n} kept`));
  const terms = await ds.query('SELECT term_name, start_date::text AS start_date, end_date::text AS end_date FROM term_dates ORDER BY start_date');
  checks.push(result('calendar.terms', 'Terms (compare with the FMS range 2026-08-17 to 2026-12-12)', 'INFO', list(terms, (t) => `${t.term_name} ${t.start_date}..${t.end_date}`) || 'no terms entered'));
  return checks;
}

async function constraints(ds) {
  const checks = [];
  const present = async (sql, params) => (await ds.query(sql, params)).length > 0;
  checks.push(result('constraints.office_code_index', 'offices_code_lower_uq exists', (await present("SELECT 1 FROM pg_indexes WHERE indexname = 'offices_code_lower_uq'")) ? 'PASS' : 'FAIL'));
  checks.push(result('constraints.institution_trigger', 'Institution code cannot be changed (trigger)', (await present("SELECT 1 FROM pg_trigger WHERE tgname = 'catalogue_institution_immutable'")) ? 'PASS' : 'FAIL'));
  checks.push(result('constraints.service_code_trigger', 'Service code cannot be changed (trigger)', (await present("SELECT 1 FROM pg_trigger WHERE tgname = 'services_code_immutable'")) ? 'PASS' : 'FAIL'));
  checks.push(result('constraints.class_mode_check', 'class_mode check exists', (await present("SELECT 1 FROM pg_constraint WHERE conname = 'calendar_exception_class_mode_ck'")) ? 'PASS' : 'FAIL'));
  const [idx] = await ds.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'calendar_exceptions_scope_date_uq'");
  checks.push(result('constraints.scope_date_index', 'One entry per date and scope, tombstones ignored', idx && /removed_at/i.test(idx.indexdef) ? 'PASS' : 'FAIL', idx ? '' : 'index missing'));

  // Probes: each bad insert or update must be rejected by the database. Always rolled back.
  const id = randomUUID();
  const base = (extra) => `INSERT INTO calendar_exceptions (exception_id, exception_date, exception_type, description, is_recurring${extra.cols}) VALUES ('${id}', '2099-01-01', 'REGULAR_HOLIDAY', 'probe', false${extra.vals})`;
  const probes = [
    ['probe.office_class', 'Database refuses a one-office entry that affects classes', base({ cols: ', office_id, applies_to, class_mode', vals: `, '${randomUUID()}', 'BOTH', 'SUSPENDED'` })],
    ['probe.end_without_start', 'Database refuses an end time without a start time', base({ cols: ', suspended_until', vals: ", '17:00'" })],
    ['probe.bad_class_mode', 'Database refuses a WORK entry with a class_mode', base({ cols: ', applies_to, class_mode', vals: ", 'WORK', 'ONLINE'" })],
  ];
  for (const [pid, label, sql] of probes) checks.push(result(pid, label, (await expectRejected(ds, sql)) ? 'PASS' : 'FAIL'));
  checks.push(result(
    'probe.office_code_case',
    'Database refuses two office codes that differ only in letter case',
    (await expectRejected(ds, `INSERT INTO offices (office_id, office_code, office_name) SELECT gen_random_uuid(), upper(office_code), 'probe' FROM offices LIMIT 1`)) ? 'PASS' : 'INFO',
    'INFO when there are no offices to copy',
  ));
  return checks;
}

export async function runReadiness(ds, { baseline } = {}) {
  return [...(await offices(ds)), ...(baseline ? await officeBaseline(ds, baseline) : []), ...(await freeze(ds)), ...(await calendar(ds)), ...(await constraints(ds))];
}

export const readinessFailed = (checks) => checks.some((c) => c.status === 'FAIL');
