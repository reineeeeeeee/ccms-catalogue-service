'use client';

import { useCallback, useEffect, useState } from 'react';
import { ROLE_LABELS } from 'ccms-shared/roles';
import ErrorBanner from '../../components/ErrorBanner.js';
import { apiFetch } from '../../lib/client/session.js';
import { DAY_NAMES, DAY_SHORT, WEEK_ORDER, describeSchedule, manilaDateTime } from '../../lib/client/calendar.js';

const DEFAULT_OPEN = '08:00';
const DEFAULT_CLOSE = '17:00';

function toRows(items) {
  return [...items]
    .sort((a, b) => a.day_of_week - b.day_of_week)
    .map((d) => ({ day_of_week: d.day_of_week, is_working: d.is_working, opening_time: d.opening_time ?? '', closing_time: d.closing_time ?? '' }));
}

// True when every working day has the same opening and closing time (one daily shift for the week).
function sameShift(rows) {
  const working = rows.filter((r) => r.is_working);
  return working.every((r) => r.opening_time === working[0].opening_time && r.closing_time === working[0].closing_time);
}

const labelClass = 'block text-xs font-bold uppercase tracking-wide text-slate-600';
const timeClass =
  'mt-2 block w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 focus:border-green-700 focus:outline-none focus:ring-2 focus:ring-green-700/20 disabled:bg-slate-50 disabled:text-slate-500';

function Required() {
  return <span className="text-red-600"> *</span>;
}

export default function WorkingHours({ canWrite = false, onChanged }) {
  const [state, setState] = useState({ loading: true, rows: [], error: null });
  const [custom, setCustom] = useState(false); // different hours for different days
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [history, setHistory] = useState({ loading: canWrite, items: [], total: 0, error: null });

  const loadHistory = useCallback(async () => {
    if (!canWrite) return;
    try {
      const data = await apiFetch('/api/calendar/schedule/history');
      setHistory({ loading: false, items: data.items ?? [], total: data.total ?? 0, error: null });
    } catch (err) {
      setHistory((h) => ({ ...h, loading: false, error: err.message }));
    }
  }, [canWrite]);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/calendar/schedule');
      const rows = toRows(data.items);
      setState({ loading: false, rows, error: null });
      setCustom(!sameShift(rows));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    load();
    loadHistory();
  }, [load, loadHistory]);

  const working = state.rows.filter((r) => r.is_working);
  const shiftStart = working[0]?.opening_time || DEFAULT_OPEN;
  const shiftEnd = working[0]?.closing_time || DEFAULT_CLOSE;

  const patchRows = (fn) => {
    setMessage(null);
    setState((s) => ({ ...s, rows: s.rows.map(fn) }));
  };

  function toggleDay(day) {
    patchRows((r) => {
      if (r.day_of_week !== day) return r;
      return r.is_working
        ? { ...r, is_working: false, opening_time: '', closing_time: '' }
        : { ...r, is_working: true, opening_time: shiftStart, closing_time: shiftEnd };
    });
  }

  // One shift for every working day.
  const setShift = (patch) => patchRows((r) => (r.is_working ? { ...r, ...patch } : r));
  // Hours of a single day (when the days differ).
  const setDay = (day, patch) => patchRows((r) => (r.day_of_week === day ? { ...r, ...patch } : r));

  function useSameHours() {
    setShift({ opening_time: shiftStart, closing_time: shiftEnd });
    setCustom(false);
  }

  async function save(event) {
    event.preventDefault();
    if (!canWrite) return;
    setSaving(true);
    setSaveError(null);
    setMessage(null);
    try {
      const days = state.rows.map((r) =>
        r.is_working ? { day_of_week: r.day_of_week, is_working: true, opening_time: r.opening_time.trim(), closing_time: r.closing_time.trim() } : { day_of_week: r.day_of_week, is_working: false },
      );
      const data = await apiFetch('/api/calendar/schedule', { method: 'PUT', body: { days } });
      const rows = toRows(data.items);
      setState({ loading: false, rows, error: null });
      setCustom(!sameShift(rows));
      setMessage('Working hours saved and published.');
      onChanged?.();
      loadHistory();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const byDay = new Map(state.rows.map((r) => [r.day_of_week, r]));

  return (
    <div className={`grid gap-6 ${canWrite ? 'lg:grid-cols-[3fr_2fr]' : ''}`}>
      <form onSubmit={save} className="card p-6" aria-label="Working hours">
        <div className="mb-4 space-y-3 empty:hidden">
          <ErrorBanner message={state.error} />
          <ErrorBanner message={saveError} onDismiss={() => setSaveError(null)} />
        </div>
        {message ? (
          <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {message}
          </p>
        ) : null}

        {state.loading ? (
          <p className="text-sm text-slate-500">Loading working hours…</p>
        ) : (
          <>
            <p id="days-label" className={labelClass}>
              Working days (calendar schedule)
              {canWrite ? <Required /> : null}
            </p>
            <div role="group" aria-labelledby="days-label" className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-7">
              {WEEK_ORDER.map((day) => {
                const on = byDay.get(day)?.is_working;
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${DAY_NAMES[day]}: ${on ? 'working day' : 'non-working day'}`}
                    disabled={!canWrite}
                    onClick={() => toggleDay(day)}
                    className={`rounded-full border px-3 py-3 text-sm font-semibold transition-colors ${
                      on ? 'border-green-700 bg-green-50 text-green-800' : 'border-slate-300 bg-white text-slate-800 hover:border-slate-400'
                    } ${canWrite ? '' : 'cursor-default'}`}
                  >
                    {DAY_SHORT[day]}
                  </button>
                );
              })}
            </div>

            {!custom || working.length === 0 ? (
              <div className="mt-8 grid gap-6 sm:grid-cols-2">
                <div>
                  <label htmlFor="shift-start" className={labelClass}>
                    Daily shift time start
                    {canWrite ? <Required /> : null}
                  </label>
                  <input id="shift-start" type="time" className={timeClass} value={shiftStart} disabled={!canWrite || working.length === 0} onChange={(e) => setShift({ opening_time: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="shift-end" className={labelClass}>
                    Daily shift time end
                    {canWrite ? <Required /> : null}
                  </label>
                  <input id="shift-end" type="time" className={timeClass} value={shiftEnd} disabled={!canWrite || working.length === 0} onChange={(e) => setShift({ closing_time: e.target.value })} />
                </div>
              </div>
            ) : (
              <div className="mt-8">
                <p className={labelClass}>Daily shift time by day</p>
                <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {WEEK_ORDER.filter((day) => byDay.get(day)?.is_working).map((day) => {
                    const row = byDay.get(day);
                    return (
                      <li key={day} className="grid grid-cols-[6rem_1fr_1fr] items-center gap-3 px-4 py-3">
                        <span className="text-sm font-semibold text-slate-900">{DAY_NAMES[day]}</span>
                        <input aria-label={`${DAY_NAMES[day]} opening time`} type="time" className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50" value={row.opening_time} disabled={!canWrite} onChange={(e) => setDay(day, { opening_time: e.target.value })} />
                        <input aria-label={`${DAY_NAMES[day]} closing time`} type="time" className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50" value={row.closing_time} disabled={!canWrite} onChange={(e) => setDay(day, { closing_time: e.target.value })} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {canWrite && working.length > 0 ? (
              <p className="mt-3 text-sm">
                {custom ? (
                  <button type="button" className="font-semibold text-green-800 underline" onClick={useSameHours}>
                    Use the same hours for every working day
                  </button>
                ) : (
                  <button type="button" className="font-semibold text-green-800 underline" onClick={() => setCustom(true)}>
                    Set different hours for specific days
                  </button>
                )}
              </p>
            ) : null}

            {canWrite ? (
              <>
                <div role="note" className="mt-6 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800">
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                    <path d="M12 9v4M12 17h.01" />
                  </svg>
                  <p>Saving creates a new version of the working hours. This will not affect results already computed; only computations made afterwards follow the updated schedule. Times are 24-hour, Asia/Manila.</p>
                </div>
                <div className="mt-6 flex justify-end">
                  <button
                    type="submit"
                    disabled={saving || state.loading || state.rows.length === 0}
                    className="rounded-lg bg-green-700 px-8 py-3 text-base font-bold text-white hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-700/40 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? 'Saving…' : 'Save & publish working hours'}
                  </button>
                </div>
              </>
            ) : (
              <p className="mt-6 text-sm text-slate-600">The weekly schedule of the campus. Times are 24-hour, Asia/Manila.</p>
            )}
          </>
        )}
      </form>

      {canWrite ? (
        <section className="card p-6" aria-labelledby="history-heading">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <h2 id="history-heading" className="flex items-center gap-3 text-sm font-bold uppercase tracking-wide text-slate-900">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5M12 7v5l3 2" />
              </svg>
              Version history registry
            </h2>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{history.total} {history.total === 1 ? 'record' : 'records'}</span>
          </div>
          <ErrorBanner message={history.error} onDismiss={() => setHistory((h) => ({ ...h, error: null }))} />
          {history.loading ? (
            <p className="mt-6 text-sm text-slate-500">Loading history…</p>
          ) : history.items.length === 0 ? (
            <p className="mt-16 text-center text-sm italic text-slate-500">No working-hours changes recorded yet.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {history.items.map((entry) => (
                <li key={entry.audit_id} className="rounded-lg border border-slate-200 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-slate-900">Version {entry.version_no}</span>
                    <time className="text-xs text-slate-500" dateTime={entry.occurred_at}>
                      {manilaDateTime(entry.occurred_at)}
                    </time>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">{describeSchedule(entry.items)}</p>
                  {entry.actor_role ? <p className="mt-1 text-xs text-slate-500">Saved by {ROLE_LABELS[entry.actor_role] ?? entry.actor_role}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
