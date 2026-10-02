'use client';

import { useCallback, useEffect, useState } from 'react';
import ErrorBanner from '../../components/ErrorBanner.js';
import { apiFetch } from '../../lib/client/session.js';
import { SYNC_LABELS, manilaDateTime } from '../../lib/client/calendar.js';

const STATUS_CLASS = {
  FAILED: 'badge bg-red-50 text-red-700',
  ACKNOWLEDGED: 'badge bg-emerald-50 text-emerald-700',
  SENT: 'badge bg-emerald-50 text-emerald-700',
  PENDING: 'badge bg-slate-100 text-slate-600',
};

function StatusBadge({ status }) {
  return <span className={STATUS_CLASS[status] ?? 'badge bg-slate-100 text-slate-600'}>{SYNC_LABELS[status] ?? status}</span>;
}

export default function SyncPanel({ refreshKey }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/calendar/sync/status');
      setState({ loading: false, data, error: null });
    } catch (err) {
      setState((current) => ({ ...current, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const { data } = state;
  const push = data?.fms_last_push ?? null;

  return (
    <section className="card p-4" aria-labelledby="sync-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sync-heading" className="text-xl">
          Sync status
        </h2>
        <button type="button" className="btn-secondary px-3 py-1.5" onClick={load}>
          Refresh
        </button>
      </div>
      <div className="mt-3">
        <ErrorBanner message={state.error} onDismiss={() => setState((s) => ({ ...s, error: null }))} />
      </div>
      {state.loading ? (
        <p className="mt-3 text-sm text-slate-500">Loading sync status…</p>
      ) : data ? (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <p className="text-sm text-slate-700" data-testid="audit-sync">
              {data.audit_last_synced ? `Audit last synced: ${manilaDateTime(data.audit_last_synced)} (Asia/Manila)` : 'Audit has not synced yet'}
            </p>
            <p className="text-sm text-slate-700" data-testid="fms-push">
              {push ? (
                <>
                  Last FMS push: <StatusBadge status={push.status} /> <span className="text-slate-500">{manilaDateTime(push.at)} (Asia/Manila)</span>
                </>
              ) : (
                'No FMS push yet'
              )}
            </p>
          </div>
          {push?.status === 'FAILED' ? (
            <p className="mt-2 text-sm font-semibold text-red-700">The last push to FMS failed. It will be retried automatically; your changes are saved.</p>
          ) : null}
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-maroon-950">
                <tr>
                  <th className="th">System</th>
                  <th className="th">Event</th>
                  <th className="th">Status</th>
                  <th className="th">Last synced</th>
                  <th className="th text-right">Attempts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recent.length === 0 ? (
                  <tr>
                    <td className="td text-slate-500" colSpan={5}>
                      No changes have been shared yet.
                    </td>
                  </tr>
                ) : (
                  data.recent.map((row) => (
                    <tr key={row.sync_id} className={row.status === 'FAILED' ? 'bg-red-50/40' : ''}>
                      <td className="td font-semibold">{row.consumer_system}</td>
                      <td className="td">{row.event_type}</td>
                      <td className="td">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="td">{row.last_synced_at ? manilaDateTime(row.last_synced_at) : '-'}</td>
                      <td className="td text-right">{row.attempts}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
