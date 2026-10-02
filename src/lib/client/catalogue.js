// Small helpers shared by the catalogue pages. Everything returned here is plain text or data;
// pages render it through React (escaped), never as HTML.

export const CLASSIFICATIONS = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'COMPLEX', label: 'Complex' },
  { value: 'HIGHLY_TECHNICAL', label: 'Highly Technical' },
];
export const TRANSACTION_TYPES = [
  { value: 'G2C', label: 'G2C (Government to Citizen)' },
  { value: 'G2G', label: 'G2G (Government to Government)' },
  { value: 'G2B', label: 'G2B (Government to Business)' },
];
export const DURATION_UNITS = [
  { value: 'MINUTES', label: 'Minutes' },
  { value: 'HOURS', label: 'Hours' },
  { value: 'WORKING_DAYS', label: 'Working days' },
];

export function classificationLabel(value) {
  return CLASSIFICATIONS.find((c) => c.value === value)?.label ?? value;
}

const UNIT_WORDS = { MINUTES: ['minute', 'minutes'], HOURS: ['hour', 'hours'], WORKING_DAYS: ['working day', 'working days'] };

/** "7 minutes", "1 hour", "3 working days". */
export function standardText(value, unit) {
  const words = UNIT_WORDS[unit];
  if (!words || value == null) return '';
  return `${value} ${Number(value) === 1 ? words[0] : words[1]}`;
}

/** Fetches a public (no login) endpoint; turns HTTP 429 and other failures into readable messages. */
export async function publicFetch(path) {
  let response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    const error = new Error('Cannot reach the server. Check your connection and try again.');
    error.status = 0;
    throw error;
  }
  if (response.status === 429) {
    const wait = Number(response.headers.get('retry-after'));
    let message = 'Too many requests. Please wait a moment and try again.';
    try {
      const body = await response.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* keep the default message */
    }
    if (wait > 0) message += ` (try again in about ${wait} second${wait === 1 ? '' : 's'})`;
    const error = new Error(message);
    error.status = 429;
    throw error;
  }
  if (!response.ok) {
    let message = response.status === 404 ? 'This service could not be found.' : 'Something went wrong. Please try again.';
    try {
      const body = await response.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* keep the default message */
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function toQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') query.set(key, String(value).trim());
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}
