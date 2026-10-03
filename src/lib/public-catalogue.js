import { Errors, buildErrorBody, clientIp, isUuid } from 'ccms-shared';
import { likePattern, manilaToday, parsePaging, standardText } from './catalogue-rules.js';
import { listDocumentRows } from './documents.js';
import { publicLimiter, publicLimits } from './rate-limit.js';

export const RATE_LIMITED = 'Too many requests. Please wait a moment and try again.';

/**
 * Applies the in-memory limiter per client address. Returns null when allowed, or a ready 429
 * Response (readable message + Retry-After). Needs the `route` wrapper for the correlation id.
 */
export function limitPublicRequest(request, correlationId) {
  const key = clientIp(request) ?? 'unknown';
  const result = publicLimiter.check(key, publicLimits());
  if (result.allowed) return null;
  const body = buildErrorBody({ code: 'RATE_LIMITED', message: RATE_LIMITED, correlationId: correlationId });
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(result.retryAfterSeconds) },
  });
}

// Active services with a standard in force today. Only fields safe for citizens are selected.
const PUBLIC_FROM = `
  FROM services s
  JOIN offices o ON o.office_id = s.office_id
  JOIN service_standards st
    ON st.service_id = s.service_id
   AND st.effective_from <= $1::date
   AND (st.effective_to IS NULL OR st.effective_to >= $1::date)
  WHERE s.is_active = true`;

function toPublicSummary(row) {
  return {
    service_id: row.service_id,
    service_name: row.service_name,
    office_name: row.office_name,
    classification: row.classification,
    standard_text: standardText(row.duration_value, row.duration_unit),
    duration_value: row.duration_value,
    duration_unit: row.duration_unit,
  };
}

export async function listPublicServices(dataSource, params) {
  const { page, pageSize } = parsePaging(params, { defaultSize: 12, maxSize: 50 });
  const search = params.get('search')?.trim();
  const values = [manilaToday()];
  let searchSql = '';
  if (search) {
    values.push(likePattern(search));
    searchSql = ' AND (s.service_name ILIKE $2 OR o.office_name ILIKE $2)';
  }
  const [{ total }] = await dataSource.query(`SELECT count(*)::int AS total ${PUBLIC_FROM}${searchSql}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await dataSource.query(
    `SELECT s.service_id, s.service_name, o.office_name, s.classification, st.duration_value, st.duration_unit
     ${PUBLIC_FROM}${searchSql} ORDER BY lower(s.service_name), s.service_id LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.map(toPublicSummary), page, page_size: pageSize, total };
}

export async function getPublicService(dataSource, id) {
  const rows = isUuid(id)
    ? await dataSource.query(
        `SELECT s.service_id, s.service_name, o.office_name, s.classification, s.processing_steps, s.fees,
                s.who_may_avail, st.duration_value, st.duration_unit
         ${PUBLIC_FROM} AND s.service_id = $2`,
        [manilaToday(), id],
      )
    : [];
  if (!rows[0]) throw Errors.notFound('Service not found', 'SERVICE_NOT_FOUND');
  const documents = (await listDocumentRows(dataSource, id)).map((d) => ({
    document_name: d.document_name,
    is_mandatory: d.is_mandatory,
    notes: d.notes ?? null,
  }));
  const { service_id, service_name, office_name, classification, standard_text } = toPublicSummary(rows[0]);
  return {
    service: {
      service_id,
      service_name,
      office_name,
      classification,
      standard_text,
      processing_steps: rows[0].processing_steps ?? null,
      fees: rows[0].fees ?? null,
      who_may_avail: rows[0].who_may_avail ?? null,
      documents,
    },
  };
}
