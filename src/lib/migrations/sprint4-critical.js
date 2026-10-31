/** Additive migration for existing Core databases. Run as schema owner, before deploying the new code. */
export async function migrateSprint4Core(dataSource) {
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(43436, 406)');
    await manager.query(`CREATE TABLE IF NOT EXISTS catalogue_settings (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      institution_code text CHECK (institution_code IS NULL OR institution_code ~ '^[A-Z0-9]{2,10}$'),
      applies_to_enabled boolean NOT NULL DEFAULT false)`);
    await manager.query('INSERT INTO catalogue_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
    for (const [table, name, definition] of [
      ['catalogue_settings', 'catalogue_settings_single_ck', 'CHECK (id = 1)'],
      ['catalogue_settings', 'catalogue_settings_code_ck', "CHECK (institution_code IS NULL OR institution_code ~ '^[A-Z0-9]{2,10}$')"],
    ]) {
      const [present] = await manager.query('SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass', [name, table]);
      if (!present) await manager.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
    }
    await manager.query(`CREATE OR REPLACE FUNCTION ccms_institution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND OLD.institution_code IS NOT NULL THEN
          RAISE EXCEPTION 'Institution setup cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.institution_code IS NOT NULL AND NEW.institution_code IS DISTINCT FROM OLD.institution_code THEN
          RAISE EXCEPTION 'Institution code is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    await manager.query('DROP TRIGGER IF EXISTS catalogue_institution_immutable ON catalogue_settings');
    await manager.query('CREATE TRIGGER catalogue_institution_immutable BEFORE UPDATE OR DELETE ON catalogue_settings FOR EACH ROW EXECUTE FUNCTION ccms_institution_immutable()');
    await manager.query(`CREATE TABLE IF NOT EXISTS service_code_sequences (
      office_id uuid NOT NULL, service_abbr text NOT NULL, last_seq int NOT NULL CHECK (last_seq BETWEEN 1 AND 999),
      PRIMARY KEY (office_id, service_abbr))`);
    const [sequenceCheck] = await manager.query("SELECT 1 FROM pg_constraint WHERE conname='service_code_sequence_range_ck' AND conrelid='service_code_sequences'::regclass");
    if (!sequenceCheck) await manager.query('ALTER TABLE service_code_sequences ADD CONSTRAINT service_code_sequence_range_ck CHECK (last_seq BETWEEN 1 AND 999)');
    await manager.query(`CREATE OR REPLACE FUNCTION ccms_service_code_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.service_code IS DISTINCT FROM OLD.service_code AND current_setting('ccms.legacy_recode', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'Service code is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await manager.query('DROP TRIGGER IF EXISTS services_code_immutable ON services');
    await manager.query('CREATE TRIGGER services_code_immutable BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION ccms_service_code_immutable()');
    await manager.query("ALTER TABLE calendar_exceptions ADD COLUMN IF NOT EXISTS applies_to text NOT NULL DEFAULT 'BOTH'");
    await manager.query("ALTER TABLE calendar_exceptions ADD COLUMN IF NOT EXISTS class_mode text DEFAULT 'SUSPENDED'");
    const [constraint] = await manager.query("SELECT 1 FROM pg_constraint WHERE conname = 'calendar_exception_class_mode_ck' AND conrelid = 'calendar_exceptions'::regclass");
    if (!constraint) await manager.query(`ALTER TABLE calendar_exceptions ADD CONSTRAINT calendar_exception_class_mode_ck CHECK (
      applies_to IN ('WORK','CLASSES','BOTH') AND
      ((applies_to = 'WORK' AND class_mode IS NULL) OR
       (applies_to IN ('CLASSES','BOTH') AND class_mode IS NOT NULL AND class_mode IN ('SUSPENDED','ONLINE'))))`);
    await migrateCalendarCal10(manager);
    await migrateMachineKeys(manager);
    await migrateOfficeFreeze(manager);
  });
}

const TIME_CHECK = "~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'";

async function addCheck(manager, table, name, definition) {
  const [present] = await manager.query('SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass', [name, table]);
  if (!present) await manager.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
}

/**
 * Calendar message cal-1.0 (EB3, EB4). Additive and repeatable, run inside the Sprint 4 migration:
 *   suspended_until  end time of a part-day suspension (EB4)
 *   revision         1, then +1 on every change (EB3)
 *   removed_at       a removed entry is kept as a tombstone instead of being deleted (EB3)
 * The one-entry-per-date-and-scope index now ignores tombstones, so a removed date can be entered again.
 * Existing rows keep their values: revision starts at 1 and no entry is removed or changed.
 */
export async function migrateCalendarCal10(manager) {
  await manager.query('ALTER TABLE calendar_exceptions ADD COLUMN IF NOT EXISTS suspended_until text');
  await manager.query('ALTER TABLE calendar_exceptions ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1');
  await manager.query('ALTER TABLE calendar_exceptions ADD COLUMN IF NOT EXISTS removed_at timestamptz');
  await addCheck(manager, 'calendar_exceptions', 'calendar_exceptions_revision_ck', 'CHECK (revision >= 1)');
  await addCheck(
    manager,
    'calendar_exceptions',
    'calendar_exceptions_suspended_until_ck',
    `CHECK (suspended_until IS NULL OR (suspended_until ${TIME_CHECK} AND suspended_from IS NOT NULL AND suspended_until > suspended_from))`,
  );
  // C42: classes are affected campus-wide only, so a one-office entry can only be WORK. NOT VALID: old rows that
  // break the rule are not rewritten here (the readiness report lists them); every new or changed row must obey it.
  await addCheck(
    manager,
    'calendar_exceptions',
    'calendar_exceptions_office_work_ck',
    "CHECK (office_id IS NULL OR applies_to = 'WORK') NOT VALID",
  );
  const [index] = await manager.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'calendar_exceptions_scope_date_uq'");
  if (!index || !/removed_at/i.test(index.indexdef)) {
    await manager.query('DROP INDEX IF EXISTS calendar_exceptions_scope_date_uq');
    await manager.query(
      `CREATE UNIQUE INDEX calendar_exceptions_scope_date_uq
         ON calendar_exceptions (office_id, exception_date) NULLS NOT DISTINCT WHERE removed_at IS NULL`,
    );
  }
}

/** EB7: the machine_keys table. Additive and repeatable. Holds a hash of each secret, never the secret. */
export async function migrateMachineKeys(manager) {
  await manager.query(`CREATE TABLE IF NOT EXISTS machine_keys (
    key_id uuid PRIMARY KEY,
    key_ref text NOT NULL UNIQUE,
    key_hash text NOT NULL,
    caller text NOT NULL,
    environment text NOT NULL,
    scope text NOT NULL,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    replaced_by uuid,
    created_by text)`);
  await addCheck(manager, 'machine_keys', 'machine_keys_caller_ck', "CHECK (caller IN ('FMS', 'SMS'))");
  await addCheck(manager, 'machine_keys', 'machine_keys_environment_ck', "CHECK (environment IN ('development', 'test', 'staging', 'production'))");
  await addCheck(manager, 'machine_keys', 'machine_keys_scope_ck', "CHECK (scope IN ('read-calendar'))");
}

/**
 * EB15: the office list sent to FMS is frozen. Once an office is in office_list_freeze its ID can never change and the
 * office can never be deleted (offices are deactivated instead). The freeze list itself is append-only. The database
 * enforces this, not only the screen.
 */
export async function migrateOfficeFreeze(manager) {
  await manager.query(`CREATE TABLE IF NOT EXISTS office_list_freeze (
    office_id uuid PRIMARY KEY, office_code text NOT NULL,
    frozen_at timestamptz NOT NULL DEFAULT now(), frozen_by text)`);
  await manager.query(`CREATE OR REPLACE FUNCTION ccms_frozen_office_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM office_list_freeze WHERE office_id = OLD.office_id) THEN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'A frozen office cannot be deleted: deactivate it instead' USING ERRCODE = '23514';
        END IF;
        IF NEW.office_id IS DISTINCT FROM OLD.office_id THEN
          RAISE EXCEPTION 'The ID of a frozen office cannot change' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  // The offices table may not exist yet on a very old schema; the trigger is added on the next sync, when it does.
  const [officesTable] = await manager.query("SELECT to_regclass('public.offices') AS name");
  if (officesTable.name) {
    await manager.query('DROP TRIGGER IF EXISTS offices_frozen_guard ON offices');
    await manager.query('CREATE TRIGGER offices_frozen_guard BEFORE UPDATE OR DELETE ON offices FOR EACH ROW EXECUTE FUNCTION ccms_frozen_office_guard()');
  }
  await manager.query(`CREATE OR REPLACE FUNCTION ccms_freeze_list_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'The office freeze list is append-only' USING ERRCODE = '23514'; END $$`);
  await manager.query('DROP TRIGGER IF EXISTS office_list_freeze_append_only ON office_list_freeze');
  await manager.query('CREATE TRIGGER office_list_freeze_append_only BEFORE UPDATE OR DELETE ON office_list_freeze FOR EACH ROW EXECUTE FUNCTION ccms_freeze_list_append_only()');
}
