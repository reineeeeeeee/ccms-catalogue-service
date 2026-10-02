'use client';

import { useCallback, useEffect, useState } from 'react';
import ErrorBanner from '../../components/ErrorBanner.js';
import Modal from '../../components/Modal.js';
import { apiFetch } from '../../lib/client/session.js';

const TERMS_API = '/api/calendar/terms';
const EMPTY = { term_name: '', start_date: '', end_date: '' };

export default function Terms({ canWrite = false, onChanged }) {
  const [state, setState] = useState({ loading: true, items: [], error: null });
  const [form, setForm] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch(TERMS_API);
      setState({ loading: false, items: data.items, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function open(term) {
    setFieldErrors({});
    setFormError(null);
    setForm(term ? { id: term.term_id, term_name: term.term_name, start_date: term.start_date, end_date: term.end_date } : { ...EMPTY });
  }

  async function save(event) {
    event.preventDefault();
    if (!canWrite) return;
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const body = { term_name: form.term_name.trim(), start_date: form.start_date, end_date: form.end_date };
      if (form.id) await apiFetch(`${TERMS_API}/${form.id}`, { method: 'PUT', body });
      else await apiFetch(TERMS_API, { method: 'POST', body });
      setForm(null);
      await load();
      onChanged?.();
    } catch (err) {
      setFieldErrors(err.details ?? {});
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={state.error} onDismiss={() => setState((s) => ({ ...s, error: null }))} />
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">Academic terms are shared with Audit. They do not change how CCMS computes deadlines.</p>
          {canWrite ? (
            <button type="button" className="btn-primary" onClick={() => open(null)}>
              + Add Term
            </button>
          ) : null}
        </div>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-maroon-950">
              <tr>
                <th className="th">Term</th>
                <th className="th">Start date</th>
                <th className="th">End date</th>
                {canWrite ? <th className="th text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.loading ? (
                <tr>
                  <td className="td text-slate-500" colSpan={canWrite ? 4 : 3}>
                    Loading terms…
                  </td>
                </tr>
              ) : state.items.length === 0 ? (
                <tr>
                  <td className="td text-slate-500" colSpan={canWrite ? 4 : 3}>
                    No academic terms yet.
                  </td>
                </tr>
              ) : (
                state.items.map((term) => (
                  <tr key={term.term_id}>
                    <td className="td font-semibold text-slate-900">{term.term_name}</td>
                    <td className="td">{term.start_date}</td>
                    <td className="td">{term.end_date}</td>
                    {canWrite ? (
                      <td className="td">
                        <div className="flex justify-end">
                          <button type="button" className="btn-link" onClick={() => open(term)}>
                            Edit
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {canWrite ? (
        <Modal
          open={form !== null}
          title={form?.id ? 'Edit Term' : 'Add Term'}
          onClose={saving ? undefined : () => setForm(null)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setForm(null)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" form="term-form" className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          {form ? (
            <form id="term-form" onSubmit={save} className="space-y-4">
              <ErrorBanner message={formError} />
              <div>
                <label className="label" htmlFor="term_name">
                  Term name
                </label>
                <input id="term_name" className="input" value={form.term_name} onChange={(e) => setForm({ ...form, term_name: e.target.value })} required maxLength={100} autoFocus />
                {fieldErrors.term_name ? <p className="mt-1 text-xs text-red-700">{fieldErrors.term_name}</p> : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="start_date">
                    Start date
                  </label>
                  <input id="start_date" type="date" className="input" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} required />
                  {fieldErrors.start_date ? <p className="mt-1 text-xs text-red-700">{fieldErrors.start_date}</p> : null}
                </div>
                <div>
                  <label className="label" htmlFor="end_date">
                    End date
                  </label>
                  <input id="end_date" type="date" className="input" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} required />
                  {fieldErrors.end_date ? <p className="mt-1 text-xs text-red-700">{fieldErrors.end_date}</p> : null}
                </div>
              </div>
            </form>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
