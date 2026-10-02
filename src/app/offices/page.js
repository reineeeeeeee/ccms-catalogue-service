'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLES } from 'ccms-shared/roles';
import AppShell from '../../components/AppShell.js';
import ConfirmDialog from '../../components/ConfirmDialog.js';
import ErrorBanner from '../../components/ErrorBanner.js';
import Modal from '../../components/Modal.js';
import { apiFetch } from '../../lib/client/session.js';

const OFFICES_API = '/api/catalogue/offices';
const EMPTY_FORM = { office_code: '', office_name: '' };

function OfficesManager() {
  const [state, setState] = useState({ loading: true, items: [], error: null });
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null); // { id?, office_code, office_name }
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null); // office being deactivated

  const reload = useCallback(async () => {
    try {
      const data = await apiFetch(OFFICES_API);
      setState({ loading: false, items: data.items, error: null });
    } catch (err) {
      setState((current) => ({ ...current, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return state.items;
    return state.items.filter((o) => o.office_code.toLowerCase().includes(term) || o.office_name.toLowerCase().includes(term));
  }, [state.items, search]);

  function openForm(office) {
    setFieldErrors({});
    setFormError(null);
    setForm(office ? { id: office.office_id, office_code: office.office_code, office_name: office.office_name } : { ...EMPTY_FORM });
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const body = { office_code: form.office_code, office_name: form.office_name };
      if (form.id) await apiFetch(`${OFFICES_API}/${form.id}`, { method: 'PUT', body });
      else await apiFetch(OFFICES_API, { method: 'POST', body });
      setForm(null);
      await reload();
    } catch (err) {
      // 409 carries which field clashed (code and/or name) under details; fall back to the code field.
      const details = err.details && typeof err.details === 'object' ? err.details : null;
      setFieldErrors(details ?? (err.status === 409 ? { office_code: err.message } : {}));
      setFormError(details || err.status === 409 ? null : err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setActive(office, active) {
    setSaving(true);
    try {
      await apiFetch(`${OFFICES_API}/${office.office_id}/${active ? 'reactivate' : 'deactivate'}`, { method: 'PATCH' });
      setConfirm(null);
      await reload();
    } catch (err) {
      setConfirm(null);
      setState((current) => ({ ...current, error: err.message }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={state.error} onDismiss={() => setState((s) => ({ ...s, error: null }))} />

      <div className="card p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full sm:w-72">
            <label className="label" htmlFor="office-search">
              Search office
            </label>
            <input id="office-search" className="input" placeholder="Code or name" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button type="button" className="btn-primary" onClick={() => openForm(null)}>
            + Add Office
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-maroon-950">
              <tr>
                <th className="th">Code</th>
                <th className="th">Office name</th>
                <th className="th">Status</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.loading ? (
                <tr>
                  <td className="td text-slate-500" colSpan={4}>
                    Loading offices…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td className="td text-slate-500" colSpan={4}>
                    {state.items.length === 0 ? 'No offices yet. Add the first office from the Citizen’s Charter.' : 'No offices match your search.'}
                  </td>
                </tr>
              ) : (
                visible.map((office) => (
                  <tr key={office.office_id} className={office.is_active ? '' : 'bg-slate-50'}>
                    <td className="td font-semibold text-slate-900">{office.office_code}</td>
                    <td className="td">{office.office_name}</td>
                    <td className="td">
                      <span className={office.is_active ? 'badge-active' : 'badge-inactive'}>{office.is_active ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-4">
                        <button type="button" className="btn-link" onClick={() => openForm(office)}>
                          Edit
                        </button>
                        {office.is_active ? (
                          <button type="button" className="btn-link" onClick={() => setConfirm(office)}>
                            Deactivate
                          </button>
                        ) : (
                          <button type="button" className="btn-link" onClick={() => setActive(office, true)} disabled={saving}>
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={form !== null}
        title={form?.id ? 'Edit Office' : 'Add Office'}
        onClose={saving ? undefined : () => setForm(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="office-form" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {form ? (
          <form id="office-form" onSubmit={save} className="space-y-4">
            <ErrorBanner message={formError} />
            <div>
              <label className="label" htmlFor="office_code">
                Office code
              </label>
              <input id="office_code" className="input" value={form.office_code} onChange={(e) => setForm({ ...form, office_code: e.target.value })} required maxLength={20} autoFocus />
              {fieldErrors.office_code ? <p className="mt-1 text-xs text-red-700">{fieldErrors.office_code}</p> : null}
            </div>
            <div>
              <label className="label" htmlFor="office_name">
                Office name (as printed in the Charter)
              </label>
              <input id="office_name" className="input" value={form.office_name} onChange={(e) => setForm({ ...form, office_name: e.target.value })} required maxLength={200} />
              {fieldErrors.office_name ? <p className="mt-1 text-xs text-red-700">{fieldErrors.office_name}</p> : null}
            </div>
          </form>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title="Deactivate office?"
        message={
          confirm
            ? `${confirm.office_code} will no longer be offered when adding accounts or services. Existing records that use it keep showing it. You can reactivate it later.`
            : ''
        }
        confirmLabel="Deactivate"
        danger
        busy={saving}
        onConfirm={() => setActive(confirm, false)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

export default function OfficesPage() {
  return (
    <AppShell title="Offices" subtitle="The office list as printed in the Citizen's Charter." allowedRoles={[ROLES.SUPER_ADMIN]}>
      <OfficesManager />
    </AppShell>
  );
}
