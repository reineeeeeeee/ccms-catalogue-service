import { Errors, ROLES, recordAudit } from 'ccms-shared';
import { kickOutbox } from '../outbox.js';
import { getCatalogueSettings } from './settings.js';

// EB15: freezes the office list that goes to FMS. Run it at the moment the list is sent. From then on the database refuses
// to change or delete any listed office ID. Offices added later are not frozen until the next run (they are sent later).
// Refuses while the institution is not set up or an active office does not carry the institution prefix (a CAMP- code).

export async function freezeOfficeList(dataSource, actor, { ipAddress } = {}) {
  if (actor?.role !== ROLES.SUPER_ADMIN) throw Errors.forbidden('Only a Super Admin can freeze the office list');
  const result = await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(43436, 415)');
    const { institution_code: institution } = await getCatalogueSettings(manager);
    if (!institution) throw Errors.conflict('Run the PUP setup first', 'INSTITUTION_NOT_CONFIGURED');
    const active = await manager.query('SELECT office_id, office_code, office_name FROM offices WHERE is_active = true ORDER BY office_code');
    const wrong = active.filter((o) => !o.office_code.startsWith(`${institution}-`));
    if (wrong.length) {
      throw Errors.conflict('Some active offices do not have the institution prefix yet', 'OFFICE_LIST_NOT_READY', { offices: wrong.map((o) => o.office_code) });
    }
    if (!active.length) throw Errors.conflict('There are no active offices to freeze', 'OFFICE_LIST_EMPTY');
    const added = [];
    for (const office of active) {
      const rows = await manager.query(
        'INSERT INTO office_list_freeze (office_id, office_code, frozen_by) VALUES ($1, $2, $3) ON CONFLICT (office_id) DO NOTHING RETURNING office_id',
        [office.office_id, office.office_code, actor.id ?? null],
      );
      const inserted = Array.isArray(rows[0]) ? rows[0] : rows;
      if (inserted.length) added.push(office);
    }
    const [{ n }] = await manager.query('SELECT count(*)::int AS n FROM office_list_freeze');
    await recordAudit(manager, {
      actor, action: 'OFFICE_LIST_FROZEN', entityType: 'office_list', entityId: 'freeze', entityName: 'Office list sent to FMS',
      before: null, after: { newly_frozen: added.length, frozen_total: n }, ipAddress,
    });
    return { added, total: n, active };
  });
  kickOutbox();
  return result;
}
