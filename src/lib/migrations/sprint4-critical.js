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
  });
}
