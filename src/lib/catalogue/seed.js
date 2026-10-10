import { AppError, Errors } from 'ccms-shared';
import { nameKey } from './catalogue-rules.js';
import { addDocument } from './documents.js';
import { createOffice } from './offices.js';
import { createService } from './services.js';

export const SYSTEM_ACTOR = { id: '00000000-0000-0000-0000-000000000000', role: 'super_admin' };

class DryRunRollback extends Error {}

/**
 * Wraps an open transaction so the normal library functions (which call dataSource.transaction)
 * run as savepoints inside it. One bad row then rolls back only itself.
 */
function savepointScope(manager) {
  let counter = 0;
  return {
    manager,
    async transaction(work) {
      const name = `seed_sp_${(counter += 1)}`;
      await manager.query(`SAVEPOINT ${name}`);
      try {
        const result = await work(manager);
        await manager.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await manager.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    },
  };
}

function describeError(err) {
  if (err instanceof AppError) {
    const fields = err.details && typeof err.details === 'object' ? Object.values(err.details).join('; ') : '';
    return fields && fields !== err.message ? `${err.message} (${fields})` : err.message;
  }
  return err?.message ?? String(err);
}

export function checkSeedShape(data) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(data)) throw Errors.validation('The seed file must be a JSON object with "offices" and "services" lists');
  for (const key of ['offices', 'services']) {
    if (data[key] !== undefined && !(Array.isArray(data[key]) && data[key].every(isObj))) {
      throw Errors.validation(`"${key}" must be a list of objects`);
    }
  }
  for (const s of data.services ?? []) {
    if (s.documents !== undefined && !(Array.isArray(s.documents) && s.documents.every(isObj))) {
      throw Errors.validation('Each service "documents" must be a list of objects');
    }
  }
}

/**
 * Loads offices, services (with their first standard) and checklists from a parsed seed file using
 * the same library functions and validation as the API. Duplicates (office + normalised service
 * name, or an existing office code) are reported and skipped, never inserted, so re-running a file
 * adds nothing. `dryRun` does all the work inside one transaction and rolls it back.
 * Returns { dryRun, counts, rows } where each row is { kind, label, outcome, message }.
 */
export async function runSeed(dataSource, data, { dryRun = false, actor = SYSTEM_ACTOR } = {}) {
  checkSeedShape(data);
  const rows = [];
  const report = (kind, label, outcome, message = '') => rows.push({ kind, label, outcome, message });
  const created = [];

  try {
    await dataSource.transaction(async (manager) => {
      const scope = savepointScope(manager);

      for (const [i, office] of (data.offices ?? []).entries()) {
        const label = office.office_code ?? `office #${i + 1}`;
        try {
          const existing =
            typeof office.office_code === 'string'
              ? await manager.query('SELECT 1 FROM offices WHERE lower(office_code) = lower($1)', [office.office_code.trim()])
              : [];
          if (existing.length) {
            report('office', label, 'duplicate', 'Office code already exists; skipped');
            continue;
          }
          await createOffice(scope, actor, office);
          report('office', label, 'created');
        } catch (err) {
          report('office', label, 'error', describeError(err));
        }
      }

      const seen = new Set();
      for (const [i, service] of (data.services ?? []).entries()) {
        const label = `${service.office_code ?? '?'} / ${service.service_name ?? `service #${i + 1}`}`;
        try {
          const officeRows =
            typeof service.office_code === 'string'
              ? await manager.query('SELECT office_id, is_active FROM offices WHERE lower(office_code) = lower($1)', [service.office_code.trim()])
              : [];
          if (!officeRows[0] || !officeRows[0].is_active) {
            report('service', label, 'error', 'Office not found or inactive');
            continue;
          }
          const officeId = officeRows[0].office_id;
          let key = null;
          if (typeof service.service_name === 'string' && service.service_name.trim()) {
            key = `${officeId}|${nameKey(service.service_name)}`;
            const inDb = await manager.query('SELECT 1 FROM services WHERE office_id = $1 AND service_name_key = $2', [officeId, nameKey(service.service_name)]);
            if (inDb.length || seen.has(key)) {
              report('service', label, 'duplicate', 'This office already has a service with this name; skipped');
              continue;
            }
          }
          const result = await scope.transaction(async () => {
            const made = await createService(scope, actor, { ...service, office_id: officeId });
            for (const doc of service.documents ?? []) await addDocument(scope, actor, made.service_id, doc);
            return made;
          });
          if (key) seen.add(key);
          created.push(result.service_id);
          report('service', label, 'created', `${(service.documents ?? []).length} document(s)`);
        } catch (err) {
          const duplicate = err instanceof AppError && err.code === 'SERVICE_NAME_EXISTS';
          report('service', label, duplicate ? 'duplicate' : 'error', describeError(err));
        }
      }
      if (dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  const count = (kind, outcome) => rows.filter((r) => r.kind === kind && r.outcome === outcome).length;
  const counts = {
    offices_created: count('office', 'created'),
    offices_duplicate: count('office', 'duplicate'),
    services_created: count('service', 'created'),
    services_duplicate: count('service', 'duplicate'),
    errors: rows.filter((r) => r.outcome === 'error').length,
  };
  return { dryRun, counts, rows };
}
