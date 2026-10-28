import { Errors, ROLES, recordAudit } from 'ccms-shared';
import { kickOutbox } from '../outbox.js';

export async function getCatalogueSettings(manager) {
  const [row] = await manager.query('SELECT institution_code, applies_to_enabled FROM catalogue_settings WHERE id = 1');
  return row ?? { institution_code: null, applies_to_enabled: false };
}

export async function requireInstitution(manager) {
  const { institution_code: code } = await getCatalogueSettings(manager);
  if (!code) throw Errors.conflict('A Super Admin must initialize the institution code first', 'INSTITUTION_NOT_CONFIGURED');
  return code;
}

/** Initial setup is serialized. Repeating the same value is an explicit, audited no-op. */
export async function updateCatalogueSettings(dataSource, actor, body, { ipAddress } = {}) {
  const details = {};
  if (Object.hasOwn(body, 'institution_code') && (typeof body.institution_code !== 'string' || !/^[A-Z0-9]{2,10}$/.test(body.institution_code))) {
    details.institution_code = 'Institution code must be 2 to 10 uppercase letters or digits';
  }
  if (Object.hasOwn(body, 'applies_to_enabled') && typeof body.applies_to_enabled !== 'boolean') details.applies_to_enabled = 'Must be true or false';
  if (Object.keys(body).some((key) => !['institution_code', 'applies_to_enabled'].includes(key))) details.settings = 'Unknown setting';
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  const outcome = await dataSource.transaction(async (manager) => {
    await manager.query('INSERT INTO catalogue_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await manager.query('SELECT id FROM catalogue_settings WHERE id = 1 FOR UPDATE');
    const before = await getCatalogueSettings(manager);
    const denied = actor.role !== ROLES.SUPER_ADMIN;
    const immutable = before.institution_code && body.institution_code !== undefined && body.institution_code !== before.institution_code;
    if (denied || immutable) {
      await recordAudit(manager, { actor, action: 'CATALOGUE_SETTINGS_CHANGE_REJECTED', entityType: 'catalogue_settings', entityId: 'settings', entityName: 'Institution and calendar settings', before, after: { reason: denied ? 'FORBIDDEN' : 'INSTITUTION_CODE_IMMUTABLE' }, ipAddress });
      return { error: denied ? Errors.forbidden() : Errors.conflict('The institution code is immutable after setup', 'INSTITUTION_CODE_IMMUTABLE', { institution_code: 'The institution code cannot be changed' }) };
    }
    const next = { ...before, ...body };
    if (before.applies_to_enabled && next.applies_to_enabled === false) {
      const incompatible = await manager.query("SELECT 1 FROM calendar_exceptions WHERE applies_to <> 'BOTH' OR class_mode <> 'SUSPENDED' LIMIT 1");
      if (incompatible.length) return { error: Errors.conflict('Existing class/work-specific entries must be reviewed before disabling this setting', 'CALENDAR_SETTING_IN_USE') };
    }
    await manager.query('UPDATE catalogue_settings SET institution_code = $1, applies_to_enabled = $2 WHERE id = 1', [next.institution_code, next.applies_to_enabled]);
    await recordAudit(manager, { actor, action: before.institution_code ? (JSON.stringify(before) === JSON.stringify(next) ? 'CATALOGUE_SETTINGS_UNCHANGED' : 'CATALOGUE_SETTINGS_UPDATED') : 'CATALOGUE_SETTINGS_INITIALIZED', entityType: 'catalogue_settings', entityId: 'settings', entityName: 'Institution and calendar settings', before, after: next, ipAddress });
    return { settings: next };
  });
  kickOutbox();
  if (outcome.error) throw outcome.error;
  return outcome.settings;
}
