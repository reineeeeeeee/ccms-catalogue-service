'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ROLES } from 'ccms-shared/roles';
import AppShell from '../../../components/AppShell.js';
import ConfirmDialog from '../../../components/ConfirmDialog.js';
import ErrorBanner from '../../../components/ErrorBanner.js';
import Modal from '../../../components/Modal.js';
import ServiceForm, { formToBody, serviceToForm } from '../../../components/ServiceForm.js';
import { DURATION_UNITS, classificationLabel, standardText } from '../../../lib/client/catalogue.js';
import { apiFetch } from '../../../lib/client/session.js';

const API = '/api/catalogue';
const EMPTY_STANDARD = { duration_value: '', duration_unit: 'WORKING_DAYS', effective_from: '', charter_reference: '' };
const EMPTY_DOC = { document_name: '', is_mandatory: true, notes: '' };

function FieldError({ errors, name }) {
  return errors?.[name] ? <p className="mt-1 text-xs text-red-700">{errors[name]}</p> : null;
}

function ServiceDetail({ user, id }) {
  const isAdmin = user.role === ROLES.SUPER_ADMIN;
  const [state, setState] = useState({ loading: true, service: null, standards: [], documents: [], error: null });
  const [notice, setNotice] = useState(null);
  const [offices, setOffices] = useState([]);
  const [editForm, setEditForm] = useState(null);
  const [editErrors, setEditErrors] = useState({});
  const [editError, setEditError] = useState(null);
  const [standard, setStandard] = useState({ ...EMPTY_STANDARD });
  const [standardErrors, setStandardErrors] = useState({});
  const [standardError, setStandardError] = useState(null);
  const [doc, setDoc] = useState(null); // { document_id?, ...fields }
  const [docErrors, setDocErrors] = useState({});
  const [docError, setDocError] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, item }
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await apiFetch(`${API}/services/${encodeURIComponent(id)}`);
      setState({ loading: false, service: data.service, standards: data.standards ?? [], documents: data.documents ?? [], error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, service: null, error: err.message }));
    }
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!isAdmin) return;
    apiFetch(`${API}/offices`)
      .then((data) => setOffices(data.items ?? []))
      .catch(() => setOffices([]));
  }, [isAdmin]);

  const { service, standards, documents } = state;
  const current = service?.current_standard ?? null;

  function failWith(err, setErrors, setMessage) {
    setErrors(err.details && Object.keys(err.details).length > 0 ? err.details : {});
    setMessage(err.message);
  }

  async function saveService(event) {
    event.preventDefault();
    setSaving(true);
    setEditErrors({});
    setEditError(null);
    try {
      await apiFetch(`${API}/services/${id}`, { method: 'PUT', body: formToBody(editForm, false) });
      setEditForm(null);
      setNotice('Service saved.');
      await reload();
    } catch (err) {
      failWith(err, setEditErrors, setEditError);
    } finally {
      setSaving(false);
    }
  }

  async function addStandard(event) {
    event.preventDefault();
    setSaving(true);
    setStandardErrors({});
    setStandardError(null);
    try {
      await apiFetch(`${API}/services/${id}/standards`, {
        method: 'POST',
        body: {
          duration_value: Number(standard.duration_value),
          duration_unit: standard.duration_unit,
          effective_from: standard.effective_from,
          charter_reference: standard.charter_reference,
        },
      });
      setStandard({ ...EMPTY_STANDARD });
      setNotice('New standard version added.');
      await reload();
    } catch (err) {
      failWith(err, setStandardErrors, setStandardError);
    } finally {
      setSaving(false);
    }
  }

  async function saveDoc(event) {
    event.preventDefault();
    setSaving(true);
    setDocErrors({});
    setDocError(null);
    try {
      const body = { document_name: doc.document_name, is_mandatory: doc.is_mandatory, notes: doc.notes.trim() === '' ? null : doc.notes };
      if (doc.document_id) await apiFetch(`${API}/services/${id}/documents/${doc.document_id}`, { method: 'PUT', body });
      else await apiFetch(`${API}/services/${id}/documents`, { method: 'POST', body });
      setDoc(null);
      await reload();
    } catch (err) {
      failWith(err, setDocErrors, setDocError);
    } finally {
      setSaving(false);
    }
  }

  async function runConfirm() {
    setSaving(true);
    try {
      if (confirm.kind === 'document') await apiFetch(`${API}/services/${id}/documents/${confirm.item.document_id}`, { method: 'DELETE' });
      else if (confirm.kind === 'standard') await apiFetch(`${API}/services/${id}/standards/${confirm.item.standard_id}`, { method: 'DELETE' });
      else await apiFetch(`${API}/services/${id}/${confirm.kind}`, { method: 'PATCH' });
      setConfirm(null);
      await reload();
    } catch (err) {
      setConfirm(null);
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setSaving(false);
    }
  }

  // A version can be removed only while it is still in the future: newer than the one in force.
  const isFuture = (s) => (current ? s.version_no > current.version_no : true);

  if (state.loading) return <p className="text-sm text-slate-500">Loading service…</p>;
  if (!service) {
    return (
      <div className="space-y-4">
        <ErrorBanner message={state.error ?? 'This service could not be found.'} />
        <a href="/services" className="btn-link">
          &larr; Back to services
        </a>
      </div>
    );
  }

  const confirmText = {
    deactivate: ['Deactivate service?', 'Deactivate', `${service.service_name} will disappear from the public page and can no longer be used to start transactions. You can reactivate it later.`],
    reactivate: ['Reactivate service?', 'Reactivate', `${service.service_name} will appear again in the catalogue and on the public page.`],
    document: ['Remove document?', 'Remove', confirm?.item ? `${confirm.item.document_name} will be removed from the checklist.` : ''],
    standard: ['Delete standard version?', 'Delete', confirm?.item ? `Version ${confirm.item.version_no} has not started yet and will be deleted.` : ''],
  }[confirm?.kind ?? 'deactivate'];

  return (
    <div className="space-y-4">
      <a href="/services" className="btn-link">
        &larr; Back to services
      </a>
      <ErrorBanner message={state.error} onDismiss={() => setState((s) => ({ ...s, error: null }))} />
      {notice ? (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span>{notice}</span>
          <button type="button" className="font-semibold hover:underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl">{service.service_name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {service.office_code} - {service.office_name} &middot; {service.service_code}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={service.is_active ? 'badge-active' : 'badge-inactive'}>{service.is_active ? 'Active' : 'Inactive'}</span>
            {isAdmin ? (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setEditErrors({});
                    setEditError(null);
                    setEditForm(serviceToForm(service));
                  }}
                >
                  Edit
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirm({ kind: service.is_active ? 'deactivate' : 'reactivate' })}>
                  {service.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
              </>
            ) : null}
          </div>
        </div>
        <dl className="mt-4 grid gap-4 sm:grid-cols-4">
          <div>
            <dt className="label">Classification</dt>
            <dd className="text-sm">{classificationLabel(service.classification)}</dd>
          </div>
          <div>
            <dt className="label">Transaction type</dt>
            <dd className="text-sm">{service.transaction_type}</dd>
          </div>
          <div>
            <dt className="label">Measurement</dt>
            <dd className="text-sm">Timeliness</dd>
          </div>
          <div>
            <dt className="label">Current standard</dt>
            <dd className="text-sm font-semibold">{current ? standardText(current.duration_value, current.duration_unit) : 'None in force'}</dd>
            {current ? <dd className="text-xs text-slate-500">{current.charter_reference}</dd> : null}
          </div>
          <div>
            <dt className="label">Fees</dt>
            <dd className="text-sm">{service.fees ?? 'Not specified'}</dd>
          </div>
          <div>
            <dt className="label">Who may avail</dt>
            <dd className="text-sm">{service.who_may_avail ?? 'Not specified'}</dd>
          </div>
        </dl>
      </div>

      <div className="card p-6">
        <h2 className="text-lg">Procedure steps</h2>
        {service.processing_steps ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{service.processing_steps}</p>
        ) : (
          <p className="mt-2 text-sm text-slate-500">No procedure steps recorded. {isAdmin ? 'Use Edit to add them.' : ''}</p>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="p-6 pb-3">
          <h2 className="text-lg">Standards</h2>
          <p className="text-sm text-slate-600">Each transaction is judged against the version in force on the day it started.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-maroon-950">
              <tr>
                <th className="th">Version</th>
                <th className="th">Standard</th>
                <th className="th">Effective from</th>
                <th className="th">Effective to</th>
                <th className="th">Charter reference</th>
                {isAdmin ? <th className="th text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {standards.length === 0 ? (
                <tr>
                  <td className="td text-slate-500" colSpan={isAdmin ? 6 : 5}>
                    No standard versions yet.
                  </td>
                </tr>
              ) : (
                standards.map((s) => (
                  <tr key={s.standard_id} className={current && s.standard_id === current.standard_id ? 'bg-maroon-50' : ''}>
                    <td className="td font-semibold">
                      v{s.version_no}
                      {current && s.standard_id === current.standard_id ? <span className="badge-role ml-2">In force</span> : null}
                    </td>
                    <td className="td">{standardText(s.duration_value, s.duration_unit)}</td>
                    <td className="td">{s.effective_from}</td>
                    <td className="td">{s.effective_to ?? 'Open'}</td>
                    <td className="td">{s.charter_reference}</td>
                    {isAdmin ? (
                      <td className="td text-right">
                        {isFuture(s) ? (
                          <button type="button" className="btn-link" onClick={() => setConfirm({ kind: 'standard', item: s })}>
                            Delete
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {isAdmin ? (
          <form onSubmit={addStandard} className="border-t border-slate-200 p-6">
            <h3 className="text-base">Add New Version</h3>
            <ErrorBanner message={standardError} />
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <label className="label" htmlFor="std-value">
                  Duration value
                </label>
                <input id="std-value" type="number" min={1} step={1} className="input" value={standard.duration_value} onChange={(e) => setStandard({ ...standard, duration_value: e.target.value })} required />
                <FieldError errors={standardErrors} name="duration_value" />
              </div>
              <div>
                <label className="label" htmlFor="std-unit">
                  Duration unit
                </label>
                <select id="std-unit" className="input" value={standard.duration_unit} onChange={(e) => setStandard({ ...standard, duration_unit: e.target.value })}>
                  {DURATION_UNITS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
                <FieldError errors={standardErrors} name="duration_unit" />
              </div>
              <div>
                <label className="label" htmlFor="std-from">
                  Effective from
                </label>
                <input id="std-from" type="date" className="input" value={standard.effective_from} onChange={(e) => setStandard({ ...standard, effective_from: e.target.value })} required />
                <FieldError errors={standardErrors} name="effective_from" />
              </div>
              <div className="lg:col-span-2">
                <label className="label" htmlFor="std-ref">
                  Charter reference
                </label>
                <input id="std-ref" className="input" value={standard.charter_reference} onChange={(e) => setStandard({ ...standard, charter_reference: e.target.value })} required maxLength={200} />
                <FieldError errors={standardErrors} name="charter_reference" />
              </div>
            </div>
            <button type="submit" className="btn-primary mt-4" disabled={saving}>
              {saving ? 'Saving…' : 'Add version'}
            </button>
          </form>
        ) : null}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-6 pb-3">
          <div>
            <h2 className="text-lg">Required documents</h2>
            <p className="text-sm text-slate-600">What a citizen should bring. Mandatory items are marked.</p>
          </div>
          {isAdmin ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setDocErrors({});
                setDocError(null);
                setDoc({ ...EMPTY_DOC });
              }}
            >
              + Add Document
            </button>
          ) : null}
        </div>
        {documents.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-slate-500">No required documents listed.</p>
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {documents.map((d) => (
              <li key={d.document_id} className="flex flex-wrap items-start justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{d.document_name}</span>
                    {d.is_mandatory ? <span className="badge bg-maroon-50 text-maroon-800">Mandatory</span> : <span className="badge-inactive">Optional</span>}
                  </div>
                  {d.notes ? <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{d.notes}</p> : null}
                </div>
                {isAdmin ? (
                  <div className="flex gap-4">
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => {
                        setDocErrors({});
                        setDocError(null);
                        setDoc({ document_id: d.document_id, document_name: d.document_name, is_mandatory: d.is_mandatory, notes: d.notes ?? '' });
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className="btn-link" onClick={() => setConfirm({ kind: 'document', item: d })}>
                      Remove
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={editForm !== null}
        title="Edit Service"
        widthClass="max-w-2xl"
        onClose={saving ? undefined : () => setEditForm(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditForm(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="edit-service-form" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {editForm ? (
          <div className="space-y-4">
            <ErrorBanner message={editError} />
            <ServiceForm id="edit-service-form" form={editForm} setForm={setEditForm} errors={editErrors} offices={offices} isNew={false} onSubmit={saveService} />
          </div>
        ) : null}
      </Modal>

      <Modal
        open={doc !== null}
        title={doc?.document_id ? 'Edit Document' : 'Add Document'}
        onClose={saving ? undefined : () => setDoc(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDoc(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="doc-form" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {doc ? (
          <form id="doc-form" onSubmit={saveDoc} className="space-y-4">
            <ErrorBanner message={docError} />
            <div>
              <label className="label" htmlFor="doc-name">
                Document name
              </label>
              <input id="doc-name" className="input" value={doc.document_name} onChange={(e) => setDoc({ ...doc, document_name: e.target.value })} required maxLength={200} autoFocus />
              <FieldError errors={docErrors} name="document_name" />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={doc.is_mandatory} onChange={(e) => setDoc({ ...doc, is_mandatory: e.target.checked })} />
              Mandatory
            </label>
            <div>
              <label className="label" htmlFor="doc-notes">
                Notes (optional, plain text)
              </label>
              <textarea id="doc-notes" className="input" rows={3} value={doc.notes} onChange={(e) => setDoc({ ...doc, notes: e.target.value })} maxLength={1000} />
              <FieldError errors={docErrors} name="notes" />
            </div>
          </form>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={confirmText[0]}
        message={confirmText[2]}
        confirmLabel={confirmText[1]}
        danger={confirm ? confirm.kind !== 'reactivate' : false}
        busy={saving}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

export default function ServiceDetailPage() {
  const { id } = useParams();
  return (
    <AppShell title="Service Details" subtitle="Standard, required documents and procedure steps.">
      {(user) => <ServiceDetail user={user} id={id} />}
    </AppShell>
  );
}
