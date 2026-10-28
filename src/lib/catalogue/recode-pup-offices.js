import { Errors, isUuid } from 'ccms-shared';
import { updateOffice } from './offices.js';
import { setServiceActive, updateService } from './services.js';

export const PUP_OFFICE_RECODE = [
  { from: 'CAMP-ADMIN', to: 'PUP-ADMIN', expectedServices: 36 },
  { from: 'CAMP-ACAD', to: 'PUP-ACAD', expectedServices: 10 },
  { from: 'CAMP-OSAS', to: 'PUP-OSAS', expectedServices: 20 },
  { from: 'CAMP-ACCT', to: 'PUP-ACCT', expectedServices: 3 },
];

export const SUPERSEDED_OSAS_CODES = new Set([
  'PUP-OSAS-ADM-001',
  'PUP-OSAS-ADM-002',
  'PUP-OSAS-ADM-003',
  'PUP-OSAS-ADM-004',
  'PUP-OSAS-CRD-001',
  'PUP-OSAS-CRD-002',
  'PUP-OSAS-CRD-003',
  'PUP-OSAS-CRD-004',
  'PUP-OSAS-CRD-006',
  'PUP-OSAS-GRD-001',
  'PUP-OSAS-GRD-002',
  'PUP-OSAS-GRD-003',
]);

class DryRunRollback extends Error {
  constructor(result) {
    super('Dry run rollback');
    this.result = result;
  }
}

function serviceInput(service, serviceCode) {
  return {
    office_id: service.office_id,
    service_code: serviceCode,
    service_name: service.service_name,
    classification: service.classification,
    service_scope: service.service_scope,
    transaction_types: service.transaction_types,
    processing_steps: service.processing_steps,
    fees: service.fees,
    who_may_avail: service.who_may_avail,
  };
}

async function buildPlan(manager) {
  const codes = PUP_OFFICE_RECODE.flatMap(({ from, to }) => [from, to]);
  const offices = await manager.query(
    `SELECT office_id, office_code, office_name, is_active
       FROM offices
      WHERE upper(office_code) = ANY($1::text[])
      ORDER BY office_code
      FOR UPDATE`,
    [codes],
  );
  const byCode = new Map(offices.map((office) => [office.office_code.toUpperCase(), office]));
  const allServiceCodes = await manager.query('SELECT service_id, lower(service_code) AS service_code FROM services');
  const serviceCodeOwners = new Map(allServiceCodes.map((service) => [service.service_code, service.service_id]));
  const items = [];

  for (const mapping of PUP_OFFICE_RECODE) {
    const oldOffice = byCode.get(mapping.from);
    const newOffice = byCode.get(mapping.to);
    if (oldOffice && newOffice) {
      throw Errors.conflict(
        `Both ${mapping.from} and ${mapping.to} exist; resolve the duplicate offices before recoding`,
        'OFFICE_RECODE_CONFLICT',
      );
    }
    if (!oldOffice) {
      items.push({ ...mapping, outcome: newOffice ? 'already_recoded' : 'not_found', services: [] });
      continue;
    }

    const services = await manager.query(
      `SELECT service_id, office_id, service_code, service_name, classification, service_scope,
              transaction_types, processing_steps, fees, who_may_avail, is_active
         FROM services
        WHERE office_id = $1
        ORDER BY service_code
        FOR UPDATE`,
      [oldOffice.office_id],
    );
    if (services.length !== mapping.expectedServices) {
      throw Errors.conflict(
        `${mapping.from} has ${services.length} service(s); expected ${mapping.expectedServices}. Nothing was changed`,
        'OFFICE_RECODE_SERVICE_COUNT_MISMATCH',
      );
    }

    const plannedServices = services.map((service) => {
      const currentCode = service.service_code.toUpperCase();
      if (!currentCode.startsWith(`${mapping.from}-`)) {
        throw Errors.conflict(
          `${service.service_code} does not begin with ${mapping.from}-; nothing was changed`,
          'SERVICE_RECODE_PREFIX_MISMATCH',
        );
      }
      const serviceCode = `${mapping.to}${currentCode.slice(mapping.from.length)}`;
      const owner = serviceCodeOwners.get(serviceCode.toLowerCase());
      if (owner && owner !== service.service_id) {
        throw Errors.conflict(`${serviceCode} already exists; nothing was changed`, 'SERVICE_RECODE_CONFLICT');
      }
      return {
        ...service,
        serviceCode,
        deactivate: mapping.to === 'PUP-OSAS' && SUPERSEDED_OSAS_CODES.has(serviceCode) && service.is_active,
      };
    });

    if (mapping.to === 'PUP-OSAS') {
      const present = new Set(plannedServices.map((service) => service.serviceCode));
      const missing = [...SUPERSEDED_OSAS_CODES].filter((code) => !present.has(code));
      if (missing.length) {
        throw Errors.conflict(
          `The OSAS services to deactivate are incomplete (${missing.join(', ')}); nothing was changed`,
          'OSAS_DEACTIVATION_SET_INCOMPLETE',
        );
      }
    }
    items.push({ ...mapping, outcome: 'recode', office: oldOffice, services: plannedServices });
  }
  return items;
}

/**
 * Recode the four previously seeded CAMP offices without changing their IDs, then deactivate the
 * 12 OSAS services replaced by the ADMREG/REG seed files. The whole operation commits or rolls back
 * as one transaction. A real run requires the responsible Super Admin as the audit actor.
 */
export async function recodePupOffices(dataSource, { dryRun = false, actor } = {}) {
  if (!dryRun && (!actor || !isUuid(actor.id))) {
    throw Errors.validation('A valid Super Admin actor id is required for a real recode', { actor: 'Use --actor <super-admin-account-id>' });
  }
  const auditActor = actor ?? { id: '00000000-0000-0000-0000-000000000000', role: 'super_admin' };

  try {
    return await dataSource.transaction(async (manager) => {
      const plan = await buildPlan(manager);
      // Only this reviewed administrative migration may rewrite legacy prefixes. Never set by HTTP handlers.
      await manager.query("SELECT set_config('ccms.legacy_recode', 'on', true)");
      const scope = { manager, transaction: async (work) => work(manager) };
      let officesRecoded = 0;
      let servicesRecoded = 0;
      let servicesDeactivated = 0;

      for (const item of plan) {
        if (item.outcome !== 'recode') continue;
        await updateOffice(scope, auditActor, item.office.office_id, {
          office_code: item.to,
          office_name: item.office.office_name,
        }, { trustedRecode: true });
        officesRecoded += 1;

        for (const service of item.services) {
          await updateService(scope, auditActor, service.service_id, serviceInput(service, service.serviceCode), { trustedRecode: true });
          servicesRecoded += 1;
          if (service.deactivate) {
            await setServiceActive(scope, auditActor, service.service_id, false);
            servicesDeactivated += 1;
          }
        }
      }

      const result = { dryRun, officesRecoded, servicesRecoded, servicesDeactivated, items: plan };
      if (dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
}
