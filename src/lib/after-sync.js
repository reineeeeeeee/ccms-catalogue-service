// Runs after TypeORM has created the tables. Everything here is idempotent.
// TypeORM cannot declare expression indexes, NULLS NOT DISTINCT indexes, foreign keys with our names,
// exclusion constraints or CHECK constraints, so the Catalogue's and the Calendar's data rules live here
// as well as in the service code.
async function addConstraint(dataSource, table, name, definition) {
  const rows = await dataSource.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name]);
  if (!rows.length) await dataSource.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
}

const TIME_CHECK = "~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'";

export const DEFAULT_SCHEDULE_SQL = `
  INSERT INTO working_hours (day_of_week, is_working, opening_time, closing_time)
  SELECT d, d BETWEEN 1 AND 5, CASE WHEN d BETWEEN 1 AND 5 THEN '08:00' END, CASE WHEN d BETWEEN 1 AND 5 THEN '17:00' END
  FROM generate_series(0, 6) AS d
  ON CONFLICT (day_of_week) DO NOTHING`;

export async function afterSync(dataSource) {
  await catalogueRules(dataSource);
  await calendarRules(dataSource);
}

async function catalogueRules(dataSource) {
  // Office codes are unique regardless of letter case.
  await dataSource.query('CREATE UNIQUE INDEX IF NOT EXISTS offices_code_lower_uq ON offices (lower(office_code))');

  // One service name per office, ignoring letter case and extra spaces (the key is normalised by the app).
  await dataSource.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS services_office_name_uq ON services (office_id, service_name_key)',
  );
  // Service codes are unique regardless of letter case.
  await dataSource.query('CREATE UNIQUE INDEX IF NOT EXISTS services_code_lower_uq ON services (lower(service_code))');
  // A service has at most one version per start date and per version number.
  await dataSource.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS service_standards_from_uq ON service_standards (service_id, effective_from)',
  );
  await dataSource.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS service_standards_version_uq ON service_standards (service_id, version_no)',
  );
  // A checklist lists each document once.
  await dataSource.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS required_documents_name_uq ON required_documents (service_id, document_name_key)',
  );

  await addConstraint(
    dataSource,
    'services',
    'services_office_fk',
    'FOREIGN KEY (office_id) REFERENCES offices (office_id)',
  );
  await addConstraint(
    dataSource,
    'service_standards',
    'service_standards_service_fk',
    'FOREIGN KEY (service_id) REFERENCES services (service_id)',
  );
  await addConstraint(
    dataSource,
    'required_documents',
    'required_documents_service_fk',
    'FOREIGN KEY (service_id) REFERENCES services (service_id)',
  );
  await addConstraint(
    dataSource,
    'services',
    'services_classification_ck',
    "CHECK (classification IN ('SIMPLE', 'COMPLEX', 'HIGHLY_TECHNICAL'))",
  );
  await addConstraint(
    dataSource,
    'services',
    'services_scope_ck',
    "CHECK (service_scope IN ('INTERNAL', 'EXTERNAL'))",
  );
  await addConstraint(
    dataSource,
    'services',
    'services_transaction_types_ck',
    "CHECK (cardinality(transaction_types) >= 1 AND transaction_types <@ ARRAY['G2C', 'G2G', 'G2B']::text[])",
  );
  await addConstraint(dataSource, 'services', 'services_measurement_ck', "CHECK (measurement_type = 'TIMELINESS')");
  await addConstraint(
    dataSource,
    'service_standards',
    'service_standards_duration_ck',
    `CHECK (
      duration_days BETWEEN 0 AND 1000000
      AND duration_hours BETWEEN 0 AND 1000000
      AND duration_minutes BETWEEN 0 AND 1000000
      AND (duration_days > 0 OR duration_hours > 0 OR duration_minutes > 0)
      AND version_no >= 1
    )`,
  );
  await addConstraint(
    dataSource,
    'service_standards',
    'service_standards_range_ck',
    'CHECK (effective_to IS NULL OR effective_to >= effective_from)',
  );
}

async function calendarRules(dataSource) {
  // One entry per date per scope. A null office_id (campus-wide) counts as a value, so two campus-wide
  // entries for one date collide (PostgreSQL 15+: NULLS NOT DISTINCT; a plain unique index would let
  // them through). The service also checks recurring entries by month and day before saving.
  await dataSource.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS calendar_exceptions_scope_date_uq
       ON calendar_exceptions (office_id, exception_date) NULLS NOT DISTINCT`,
  );

  await addConstraint(dataSource, 'working_hours', 'working_hours_day_ck', 'CHECK (day_of_week BETWEEN 0 AND 6)');
  await addConstraint(
    dataSource,
    'working_hours',
    'working_hours_times_ck',
    `CHECK (
      (is_working = false AND opening_time IS NULL AND closing_time IS NULL)
      OR (is_working = true AND opening_time ${TIME_CHECK} AND closing_time ${TIME_CHECK} AND closing_time > opening_time)
    )`,
  );
  await addConstraint(
    dataSource,
    'calendar_exceptions',
    'calendar_exceptions_type_ck',
    "CHECK (exception_type IN ('REGULAR_HOLIDAY', 'SPECIAL_NON_WORKING', 'SUSPENSION', 'LOCAL_HOLIDAY'))",
  );
  await addConstraint(
    dataSource,
    'calendar_exceptions',
    'calendar_exceptions_recurring_ck',
    "CHECK (is_recurring = false OR exception_type <> 'SUSPENSION')",
  );
  await addConstraint(
    dataSource,
    'calendar_exceptions',
    'calendar_exceptions_suspended_from_ck',
    `CHECK (suspended_from IS NULL OR suspended_from ${TIME_CHECK})`,
  );
  await addConstraint(dataSource, 'term_dates', 'term_dates_range_ck', 'CHECK (end_date > start_date)');
  // Terms never overlap (end dates are inclusive).
  await addConstraint(
    dataSource,
    'term_dates',
    'term_dates_no_overlap',
    "EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)",
  );
  await addConstraint(dataSource, 'sync_log', 'sync_log_consumer_ck', "CHECK (consumer_system IN ('FMS', 'AUDIT'))");
  await addConstraint(
    dataSource,
    'sync_log',
    'sync_log_status_ck',
    "CHECK (status IN ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED'))",
  );

  // The schedule always has seven rows: seed Mon-Fri 08:00-17:00 working, Sat/Sun non-working.
  await dataSource.query(DEFAULT_SCHEDULE_SQL);
}
