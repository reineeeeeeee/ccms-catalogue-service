'use client';

import { useCallback, useEffect, useState } from 'react';
import { ROLES } from 'ccms-shared/roles';
import AppShell from '../../components/AppShell.js';
import ConfirmDialog from '../../components/ConfirmDialog.js';
import ErrorBanner from '../../components/ErrorBanner.js';
import Modal from '../../components/Modal.js';
import Pager from '../../components/Pager.js';
import ServiceForm, { EMPTY_SERVICE_FORM, formToBody, serviceToForm } from '../../components/ServiceForm.js';
import { CLASSIFICATIONS, classificationLabel, standardText, toQuery } from '../../lib/client/catalogue.js';
import { apiFetch } from '../../lib/client/session.js';

const API = '/api/catalogue';
const PAGE_SIZE = 20;

function ServicesManager({ user }) {
  const isAdmin = user.role === ROLES.SUPER_ADMIN;
  // Office Head and Office Staff only ever see their own office's services (the API enforces it too).
  const ownOfficeOnly = user.role === ROLES.OFFICE_HEAD || user.role === ROLES.OFFICE_STAFF;
  const [ownOffice, setOwnOffice] = useState(null);
  const [filters, setFilters] = useState({ search: '', office_id: '', classification: '', status: 'active' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [offices, setOffices] = useState([]);
  const [state, setState] = useState({ loading: true, items: [], total: 0, error: null });
  const [form, setForm] = useState(null); // { id?, ...fields }
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    if (ownOfficeOnly) {
      if (!user.officeId) return;
      apiFetch(`${API}/offices/${encodeURIComponent(user.officeId)}`)
        .then((data) => setOwnOffice(data.office ?? null))
        .catch(() => setOwnOffice(null)); // the name is only a label
      return;
    }
    apiFetch(`${API}/offices`)
      .then((data) => setOffices(data.items ?? []))
      .catch(() => setOffices([])); // the office filter is optional
  }, [ownOfficeOnly, user.officeId]);

  const reload = useCallback(async () => {
    try {
      const query = toQuery({ ...applied, office_id: ownOfficeOnly ? undefined : applied.office_id, status: isAdmin ? applied.status : undefined, page, page_size: PAGE_SIZE });
      const data = await apiFetch(`${API}/services${query}`);
      setState({ loading: false, items: data.items, total: data.total, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [applied, page, isAdmin, ownOfficeOnly]);

  useEffect(() => {
    reload();
  }, [reload]);

  function applyFilters(next) {
    setFilters(next);
    setApplied(next);
    setPage(1);
    setState((s) => ({ ...s, loading: true }));
  }

  function openForm(service) {
    setFieldErrors({});
    setFormError(null);
    setForm(service ? { id: service.service_id, ...serviceToForm(service) } : { ...EMPTY_SERVICE_FORM });
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    try {
      if (form.id) await apiFetch(`${API}/services/${form.id}`, { method: 'PUT', body: formToBody(form, false) });
      else await apiFetch(`${API}/services`, { method: 'POST', body: formToBody(form, true) });
      setForm(null);
      await reload();
    } catch (err) {
      if (err.details && Object.keys(err.details).length > 0) setFieldErrors(err.details);
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setActive(service, active) {
    setSaving(true);
    try {
      await apiFetch(`${API}/services/${service.service_id}/${active ? 'reactivate' : 'deactivate'}`, { method: 'PATCH' });
      setConfirm(null);
      await reload();
    } catch (err) {
      setConfirm(null);
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setSaving(false);
    }
  }

  const activeOffices = offices.filter((o) => o.is_active);
  const columns = isAdmin ? 6 : 5;

  return (
    <div className="space-y-4">
      <ErrorBanner message={state.error} onDismiss={() => setState((s) => ({ ...s, error: null }))} />

      <form
        className="card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters(filters);
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-64">
            <label className="label" htmlFor="svc-search">
              Search
            </label>
            <input id="svc-search" className="input" placeholder="Service, code or office" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </div>
          {ownOfficeOnly ? (
            <div>
              <p className="label">Office</p>
              <p className="py-2 text-sm font-semibold text-slate-900" data-testid="own-office">
                {ownOffice ? `${ownOffice.office_code} - ${ownOffice.office_name}` : 'Your office'}
              </p>
            </div>
          ) : offices.length > 0 ? (
            <div>
              <label className="label" htmlFor="svc-office">
                Office
              </label>
              <select id="svc-office" className="input" value={filters.office_id} onChange={(e) => applyFilters({ ...filters, office_id: e.target.value })}>
                <option value="">All offices</option>
                {offices.map((o) => (
                  <option key={o.office_id} value={o.office_id}>
                    {o.office_code}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="svc-class">
              Classification
            </label>
            <select id="svc-class" className="input" value={filters.classification} onChange={(e) => applyFilters({ ...filters, classification: e.target.value })}>
              <option value="">All</option>
              {CLASSIFICATIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {isAdmin ? (
            <div>
              <label className="label" htmlFor="svc-status">
                Status
              </label>
              <select id="svc-status" className="input" value={filters.status} onChange={(e) => applyFilters({ ...filters, status: e.target.value })}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">All</option>
              </select>
            </div>
          ) : null}
          <button type="submit" className="btn-secondary">
            Search
          </button>
          {isAdmin ? (
            <button type="button" className="btn-primary ml-auto" onClick={() => openForm(null)}>
              + Add Service
            </button>
          ) : null}
        </div>
      </form>

      <div className="card overflow-hidden">
        {ownOfficeOnly ? <p className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600">Showing services of your office</p> : null}
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-maroon-950">
              <tr>
                <th className="th">Service</th>
                <th className="th">Office</th>
                <th className="th">Classification</th>
                <th className="th">Current standard</th>
                {isAdmin ? <th className="th">Status</th> : null}
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.loading ? (
                <tr>
                  <td className="td text-slate-500" colSpan={columns}>
                    Loading services…
                  </td>
                </tr>
              ) : state.items.length === 0 ? (
                <tr>
                  <td className="td text-slate-500" colSpan={columns}>
                    No services match your filters.
                  </td>
                </tr>
              ) : (
                state.items.map((s) => (
                  <tr key={s.service_id} className={s.is_active ? '' : 'bg-slate-50'}>
                    <td className="td">
                      <a href={`/services/${encodeURIComponent(s.service_id)}`} className="font-semibold text-maroon-800 hover:underline">
                        {s.service_name}
                      </a>
                      <p className="text-xs text-slate-500">{s.service_code}</p>
                    </td>
                    <td className="td">{s.office_code}</td>
                    <td className="td">{classificationLabel(s.classification)}</td>
                    <td className="td">
                      {s.current_standard ? standardText(s.current_standard.duration_value, s.current_standard.duration_unit) : <span className="text-slate-400">None in force</span>}
                    </td>
                    {isAdmin ? (
                      <td className="td">
                        <span className={s.is_active ? 'badge-active' : 'badge-inactive'}>{s.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                    ) : null}
                    <td className="td">
                      <div className="flex justify-end gap-4">
                        <a className="btn-link" href={`/services/${encodeURIComponent(s.service_id)}`}>
                          View
                        </a>
                        {isAdmin ? (
                          <>
                            <button type="button" className="btn-link" onClick={() => openForm(s)}>
                              Edit
                            </button>
                            {s.is_active ? (
                              <button type="button" className="btn-link" onClick={() => setConfirm({ service: s, active: false })}>
                                Deactivate
                              </button>
                            ) : (
                              <button type="button" className="btn-link" onClick={() => setConfirm({ service: s, active: true })}>
                                Reactivate
                              </button>
                            )}
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager page={page} pageSize={PAGE_SIZE} total={state.total} onPage={setPage} />
      </div>

      <Modal
        open={form !== null}
        title={form?.id ? 'Edit Service' : 'Add Service'}
        widthClass="max-w-2xl"
        onClose={saving ? undefined : () => setForm(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="service-form" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {form ? (
          <div className="space-y-4">
            <ErrorBanner message={formError} />
            <ServiceForm id="service-form" form={form} setForm={setForm} errors={fieldErrors} offices={form.id ? offices : activeOffices} isNew={!form.id} onSubmit={save} />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.active ? 'Reactivate service?' : 'Deactivate service?'}
        message={
          confirm
            ? confirm.active
              ? `${confirm.service.service_name} will appear again in the catalogue and on the public page.`
              : `${confirm.service.service_name} will disappear from the public page and can no longer be used to start transactions. Existing records keep it. You can reactivate it later.`
            : ''
        }
        confirmLabel={confirm?.active ? 'Reactivate' : 'Deactivate'}
        danger={confirm ? !confirm.active : false}
        busy={saving}
        onConfirm={() => setActive(confirm.service, confirm.active)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

export default function ServicesPage() {
  return (
    <AppShell title="Services" subtitle="The Citizen's Charter service catalogue.">
      {(user) => <ServicesManager user={user} />}
    </AppShell>
  );
}
