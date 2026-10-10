/**
 * Prepares the former single-value catalogue schema for TypeORM synchronization.
 *
 * The old duration and transaction-type values can be converted without changing meaning. Service
 * scope cannot be inferred from transaction type, so an existing database must have each old row
 * classified explicitly before synchronization is allowed to make the new column NOT NULL.
 */
export async function migrateSeedingModel(dataSource) {
  const tableExists = async (table) => {
    const [{ name }] = await dataSource.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    return Boolean(name);
  };
  const columnExists = async (table, column) => {
    const rows = await dataSource.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows.length > 0;
  };

  if (await tableExists('services')) {
    await dataSource.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS service_scope text');
    await dataSource.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS transaction_types text[]');
    if (await columnExists('services', 'transaction_type')) {
      await dataSource.query(
        'UPDATE services SET transaction_types = ARRAY[transaction_type]::text[] WHERE transaction_types IS NULL',
      );
    }
    const [{ missing_scope: missingScope, missing_types: missingTypes }] = await dataSource.query(
      `SELECT count(*) FILTER (WHERE service_scope IS NULL)::int AS missing_scope,
              count(*) FILTER (WHERE transaction_types IS NULL OR cardinality(transaction_types) = 0)::int AS missing_types
         FROM services`,
    );
    if (missingTypes > 0) {
      throw new Error(`${missingTypes} existing service(s) have no transaction_types value; populate them before running db:sync again`);
    }
    if (missingScope > 0) {
      throw new Error(
        `${missingScope} existing service(s) need service_scope set to INTERNAL or EXTERNAL before running db:sync again; scope cannot be inferred from transaction type`,
      );
    }
  }

  if (await tableExists('service_standards')) {
    await dataSource.query('ALTER TABLE service_standards ADD COLUMN IF NOT EXISTS duration_days int');
    await dataSource.query('ALTER TABLE service_standards ADD COLUMN IF NOT EXISTS duration_hours int');
    await dataSource.query('ALTER TABLE service_standards ADD COLUMN IF NOT EXISTS duration_minutes int');
    if ((await columnExists('service_standards', 'duration_value')) && (await columnExists('service_standards', 'duration_unit'))) {
      await dataSource.query(
        `UPDATE service_standards
            SET duration_days = CASE WHEN duration_unit = 'WORKING_DAYS' THEN duration_value ELSE 0 END,
                duration_hours = CASE WHEN duration_unit = 'HOURS' THEN duration_value ELSE 0 END,
                duration_minutes = CASE WHEN duration_unit = 'MINUTES' THEN duration_value ELSE 0 END
          WHERE duration_days IS NULL OR duration_hours IS NULL OR duration_minutes IS NULL`,
      );
    }
    const [{ missing }] = await dataSource.query(
      `SELECT count(*)::int AS missing
         FROM service_standards
        WHERE duration_days IS NULL OR duration_hours IS NULL OR duration_minutes IS NULL`,
    );
    if (missing > 0) {
      throw new Error(`${missing} existing service standard(s) have incomplete three-part durations; populate them before running db:sync again`);
    }
  }
}
