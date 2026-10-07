import { Errors, fromManila, isValidManilaDate, toManilaDate } from 'ccms-shared';

export const CLASSIFICATIONS = ['SIMPLE', 'COMPLEX', 'HIGHLY_TECHNICAL'];
export const TRANSACTION_TYPES = ['G2C', 'G2G', 'G2B'];
export const DURATION_UNITS = ['MINUTES', 'HOURS', 'WORKING_DAYS'];

export const OFFICE_INACTIVE = 'Office not found or inactive';
export const NAME_TAKEN = 'This office already has a service with this name';
export const CODE_TAKEN = 'Service code already exists';
export const PAST_STANDARD = 'A new standard cannot start in the past';
export const STANDARD_DATE_TAKEN = 'A standard version already starts on this date';

const UNIT_LABELS = {
  MINUTES: ['minute', 'minutes'],
  HOURS: ['hour', 'hours'],
  WORKING_DAYS: ['working day', 'working days'],
};

/** "7 minutes", "4 hours", "3 working days" (singular for 1). */
export function standardText(durationValue, durationUnit) {
  const [one, many] = UNIT_LABELS[durationUnit] ?? [durationUnit, durationUnit];
  return `${durationValue} ${durationValue === 1 ? one : many}`;
}

/** Today's calendar date in Manila, 'YYYY-MM-DD'. */
export function manilaToday() {
  return toManilaDate(new Date());
}

/** Manila calendar date `days` before/after a 'YYYY-MM-DD' date. */
export function addDays(dateString, days) {
  return toManilaDate(new Date(fromManila(dateString).getTime() + days * 24 * 60 * 60 * 1000));
}

export function collapseSpaces(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** The key that decides "same name": lower-case with single spaces. */
export function nameKey(value) {
  return collapseSpaces(value).toLowerCase();
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** {OFFICE}-{ABBR}-{NNN}, e.g. REG-TOR-001. Returns the normalised (upper-case) code or null. */
export function normaliseServiceCode(value, officeCode) {
  const code = String(value).trim().toUpperCase();
  const pattern = new RegExp(`^${escapeRegExp(String(officeCode).trim().toUpperCase())}-[A-Z0-9]{2,10}-\\d{3}$`);
  return pattern.test(code) ? code : null;
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Office-independent checks of the editable service fields. Collects every problem by field name. */
export function parseServiceFields(body, details = {}) {
  const serviceCode = str(body.service_code).trim();
  const serviceName = collapseSpaces(str(body.service_name));
  if (!serviceCode) details.service_code = 'Service code is required';
  if (!serviceName) details.service_name = 'Service name is required';
  else if (serviceName.length < 3 || serviceName.length > 100) {
    details.service_name = 'Service name must be 3 to 100 characters';
  } else if (/[<>"`]/.test(serviceName)) {
    details.service_name = 'Service name cannot contain < > " or ` characters';
  }
  if (!CLASSIFICATIONS.includes(body.classification)) {
    details.classification = `Classification must be one of ${CLASSIFICATIONS.join(', ')}`;
  }
  if (!TRANSACTION_TYPES.includes(body.transaction_type)) {
    details.transaction_type = `Transaction type must be one of ${TRANSACTION_TYPES.join(', ')}`;
  }
  if (typeof body.office_id !== 'string' || !body.office_id.trim()) details.office_id = 'Office is required';

  let processingSteps;
  if (body.processing_steps === undefined) processingSteps = undefined;
  else if (body.processing_steps === null) processingSteps = null;
  else if (typeof body.processing_steps !== 'string') details.processing_steps = 'Procedure steps must be text';
  else if (body.processing_steps.length > 10000) details.processing_steps = 'Procedure steps must be 10,000 characters or fewer';
  else processingSteps = body.processing_steps.trim() === '' ? null : body.processing_steps;

  let fees;
  if (body.fees === undefined) fees = undefined;
  else if (body.fees === null) fees = null;
  else if (typeof body.fees !== 'string') details.fees = 'Fees must be text';
  else if (body.fees.length > 500) details.fees = 'Fees must be 500 characters or fewer';
  else fees = body.fees.trim() === '' ? null : body.fees.trim();

  let whoMayAvail;
  if (body.who_may_avail === undefined) whoMayAvail = undefined;
  else if (body.who_may_avail === null) whoMayAvail = null;
  else if (typeof body.who_may_avail !== 'string') details.who_may_avail = 'Who may avail must be text';
  else if (body.who_may_avail.length > 500) details.who_may_avail = 'Who may avail must be 500 characters or fewer';
  else whoMayAvail = body.who_may_avail.trim() === '' ? null : body.who_may_avail.trim();

  return {
    officeId: typeof body.office_id === 'string' ? body.office_id.trim() : '',
    serviceCode,
    serviceName,
    classification: body.classification,
    transactionType: body.transaction_type,
    processingSteps,
    fees,
    whoMayAvail,
  };
}

/**
 * duration_value (whole number >= 1), duration_unit, effective_from (Manila date), charter_reference.
 * `prefix` names nested fields in the error details (e.g. "standard.").
 */
export function parseStandardFields(body, details = {}, prefix = '') {
  const value = body.duration_value;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 1000000) {
    details[`${prefix}duration_value`] = 'Duration must be a whole number of 1 or more';
  }
  if (!DURATION_UNITS.includes(body.duration_unit)) {
    details[`${prefix}duration_unit`] = `Unit must be one of ${DURATION_UNITS.join(', ')}`;
  }
  const effectiveFrom = str(body.effective_from).trim();
  if (!effectiveFrom) details[`${prefix}effective_from`] = 'Effective from date is required';
  else if (!isValidManilaDate(effectiveFrom)) details[`${prefix}effective_from`] = 'Effective from must be a date (YYYY-MM-DD)';
  const charterReference = collapseSpaces(str(body.charter_reference));
  if (!charterReference) details[`${prefix}charter_reference`] = 'Charter reference is required';
  else if (charterReference.length > 200) details[`${prefix}charter_reference`] = 'Charter reference must be 200 characters or fewer';
  return { durationValue: numeric, durationUnit: body.duration_unit, effectiveFrom, charterReference };
}

export function throwIfInvalid(details) {
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
}

/** page / page_size from query parameters (defaults 1 / defaultSize, size at most maxSize). */
export function parsePaging(params, { defaultSize = 20, maxSize = 100 } = {}) {
  const details = {};
  const read = (name, fallback, max) => {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) {
      details[name] = `${name} must be a whole number from 1 to ${max}`;
      return fallback;
    }
    return n;
  };
  const page = read('page', 1, 1000000);
  const pageSize = read('page_size', defaultSize, maxSize);
  throwIfInvalid(details);
  return { page, pageSize };
}

/** Escapes % _ \ for use in an ILIKE pattern. */
export function likePattern(text) {
  return `%${text.trim().replace(/[%_\\]/g, '\\$&')}%`;
}
