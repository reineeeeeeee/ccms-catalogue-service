import { Errors, isUuid } from 'ccms-shared';

export function validateAbbreviation(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{2,5}$/.test(value)) throw Errors.validation('Please correct the highlighted fields', { service_abbr: 'Service abbreviation must be 2 to 5 uppercase letters or digits' });
  return value;
}

async function highWater(manager, office, abbr) {
  const prefix = `${office.office_code}-${abbr}-`;
  const [row] = await manager.query(`SELECT GREATEST(
    COALESCE((SELECT last_seq FROM service_code_sequences WHERE office_id = $1 AND service_abbr = $2), 0),
    COALESCE((SELECT MAX(right(service_code, 3)::int) FROM services WHERE left(upper(service_code), length($3)) = upper($3) AND right(service_code, 3) ~ '^[0-9]{3}$'), 0)
    ) AS last_seq`, [office.office_id, abbr, prefix]);
  return row.last_seq;
}

function codeAfter(office, abbr, last) {
  if (last >= 999) throw Errors.conflict('No three-digit service numbers remain for this office and abbreviation', 'SERVICE_CODE_EXHAUSTED', { service_abbr: 'Choose a different abbreviation' });
  return `${office.office_code}-${abbr}-${String(last + 1).padStart(3, '0')}`;
}

/** Caller holds the office row lock. Transaction rollback rolls back the allocation as well. */
export async function allocateServiceCode(manager, office, abbr) {
  const last = await highWater(manager, office, abbr);
  const code = codeAfter(office, abbr, last);
  await manager.query(`INSERT INTO service_code_sequences (office_id, service_abbr, last_seq) VALUES ($1, $2, $3)
    ON CONFLICT (office_id, service_abbr) DO UPDATE SET last_seq = EXCLUDED.last_seq`, [office.office_id, abbr, last + 1]);
  return code;
}

export async function previewServiceCode(dataSource, officeId, abbreviation) {
  const abbr = validateAbbreviation(abbreviation);
  if (!isUuid(officeId)) throw Errors.validation('Please correct the highlighted fields', { officeId: 'Office must be a valid ID' });
  const [office] = await dataSource.query('SELECT office_id, office_code FROM offices WHERE office_id = $1 AND is_active = true', [officeId]);
  if (!office) throw Errors.notFound('Office not found or inactive', 'OFFICE_NOT_FOUND');
  return { service_code: codeAfter(office, abbr, await highWater(dataSource, office, abbr)), reserved: false };
}
