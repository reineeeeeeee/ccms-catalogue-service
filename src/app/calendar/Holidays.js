'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ConfirmDialog from '../../components/ConfirmDialog.js';
import ErrorBanner from '../../components/ErrorBanner.js';
import Modal from '../../components/Modal.js';
import { apiFetch } from '../../lib/client/session.js';
import {
  DAY_NAMES,
  EXCEPTION_TYPES,
  MONTH_NAMES,
  TYPE_CATEGORIES,
  dateString,
  daysInMonth,
  firstWeekday,
  occurrenceInMonth,
  shiftMonth,
  todayManila,
  typeCategory,
  typeLabel,
} from '../../lib/client/calendar.js';

const EXCEPTIONS_API = '/api/calendar/exceptions';
const EMPTY_FORM = { exception_date: '', exception_type: 'REGULAR_HOLIDAY', description: '', office_id: '', suspended_from: '', is_recurring: false };

export default function Holidays({ canWrite = false, onChanged }) {
  const today = todayManila();
  const [month, setMonth] = useState({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
  const [state, setState] = useState({ loading: true, items: [], error: null });
  const [offices, setOffices] = useState({ items: [], error: null });
  const [form, setForm] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filters, setFilters] = useState({ search: '', type: '' });

  const from = dateString(month.year, month.month, 1);
  const to = dateString(month.year, month.month, daysInMonth(month.year, month.month));

  const load = useCallback(async () => {
    try {
      const data = await apiFetch(`${EXCEPTIONS_API}?from=${from}&to=${to}`);
      setState({ loading: false, items: data.items, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [from, to]);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/catalogue/offices')
      .then((data) => {
        if (!cancelled) setOffices({ items: data.items, error: null });
      })
      .catch((err) => {
        if (!cancelled) setOffices({ items: [], error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const officeName = useMemo(() => {
    const map = new Map(offices.items.map((o) => [o.office_id, `${o.office_code} - ${o.office_name}`]));
    return (id) => (id ? (map.get(id) ?? 'Unknown office') : 'Campus-wide');
  }, [offices.items]);

  // Entries placed on the day they fall on in the shown month (recurring ones in the shown year).
  const rows = useMemo(
    () =>
      state.items
        .map((entry) => ({ entry, date: occurrenceInMonth(entry, month.year, month.month) }))
        .filter((r) => r.date)
        .sort((a, b) => a.date.localeCompare(b.date) || a.entry.exception_type.localeCompare(b.entry.exception_type)),
    [state.items, month],
  );

  // The search and type filters apply to the registry, the day markers and the selected-day card alike.
  const visibleRows = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    return rows.filter(({ entry, date }) => {
      if (filters.type && entry.exception_type !== filters.type) return false;
      if (!term) return true;
      return [entry.description ?? '', typeLabel(entry.exception_type), date].some((text) => text.toLowerCase().includes(term));
    });
  }, [rows, filters]);

  const byDate = useMemo(() => {
    const map = new Map();
    for (const row of visibleRows) map.set(row.date, [...(map.get(row.date) ?? []), row.entry]);
    return map;
  }, [visibleRows]);

  function goToMonth(next) {
    setMonth(next);
    setSelected(null);
  }

  function pickDay(date, inMonth) {
    if (!inMonth) setMonth({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) });
    setSelected(date);
  }

  function openForm(date) {
    setFieldErrors({});
    setFormError(null);
    setForm({ ...EMPTY_FORM, exception_date: date ?? selected ?? from });
  }

  function setType(value) {
    setForm((f) => ({ ...f, exception_type: value, is_recurring: value === 'SUSPENSION' ? false : f.is_recurring }));
  }

  async function save(event) {
    event.preventDefault();
    if (!canWrite) return;
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const body = {
        exception_date: form.exception_date,
        exception_type: form.exception_type,
        description: form.description.trim(),
        office_id: form.office_id || null,
        suspended_from: form.suspended_from.trim() || null,
        is_recurring: form.exception_type === 'SUSPENSION' ? false : form.is_recurring,
      };
      await apiFetch(EXCEPTIONS_API, { method: 'POST', body });
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

  async function remove() {
    if (!canWrite) return;
    setSaving(true);
    try {
      await apiFetch(`${EXCEPTIONS_API}/${confirm.exception_id}`, { method: 'DELETE' });
      setConfirm(null);
      await load();
      onChanged?.();
    } catch (err) {
      setConfirm(null);
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setSaving(false);
    }
  }

  // Always six weeks (42 cells), Sunday first; days of the neighbouring months are greyed.
  const leading = firstWeekday(month.year, month.month);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const prevDays = daysInMonth(prev.year, prev.month);
  const total = daysInMonth(month.year, month.month);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const offset = i - leading + 1;
    if (offset < 1) return { date: dateString(prev.year, prev.month, prevDays + offset), day: prevDays + offset, inMonth: false };
    if (offset > total) return { date: dateString(next.year, next.month, offset - total), day: offset - total, inMonth: false };
    return { date: dateString(month.year, month.month, offset), day: offset, inMonth: true };
  });
  const selectedEntries = selected ? (byDate.get(selected) ?? []) : [];

  return (
    <div className="space-y-6">
      <ErrorBanner message={state.error} onDismiss={() => setState((s) => ({ ...s, error: null }))} />

      <h2 className="text-3xl font-bold">Holiday Calendar</h2>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-full sm:w-64">
          <label className="label" htmlFor="holiday-search">
            Search holiday
          </label>
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="9" cy="9" r="6" />
              <path d="M14 14l4 4" strokeLinecap="round" />
            </svg>
            <input id="holiday-search" type="search" className="input pl-9" placeholder="Search..." value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </div>
        </div>
        <div className="w-full sm:w-44">
          <label className="label" htmlFor="holiday-type">
            Holiday type
          </label>
          <select id="holiday-type" className="input" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
            <option value="">All types</option>
            {EXCEPTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:w-44">
          <label className="label" htmlFor="holiday-month">
            Month
          </label>
          <select id="holiday-month" className="input" value={month.month} onChange={(e) => goToMonth({ year: month.year, month: Number(e.target.value) })}>
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {canWrite ? (
          <button type="button" className="btn-primary ml-auto bg-maroon-900 px-5 py-2.5" onClick={() => openForm(null)}>
            + Add Holiday
          </button>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <section className="card flex min-h-48 flex-col justify-center p-6" aria-labelledby="day-heading" aria-live="polite">
            {selected ? (
              <div>
                <h3 id="day-heading" className="text-lg font-bold">
                  {selected}
                </h3>
                {selectedEntries.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No holidays on this date.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {selectedEntries.map((entry) => {
                      const category = typeCategory(entry.exception_type);
                      return (
                        <li key={entry.exception_id} className="rounded-lg border border-slate-200 p-3 text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-semibold text-slate-900">{entry.description || typeLabel(entry.exception_type)}</p>
                            <span className={`badge shrink-0 ${category.badge}`}>{category.label}</span>
                          </div>
                          <dl className="mt-2 space-y-0.5 text-xs text-slate-600">
                            <div>Type: {typeLabel(entry.exception_type)}</div>
                            <div>Scope: {officeName(entry.office_id)}</div>
                            <div>Suspended from: {entry.suspended_from ?? 'Whole day'}</div>
                            <div>Repeats: {entry.is_recurring ? `Every year (from ${entry.exception_date.slice(0, 4)})` : 'No'}</div>
                          </dl>
                          {canWrite ? (
                            <div className="mt-2 flex justify-end">
                              <button type="button" className="btn-link" onClick={() => setConfirm(entry)}>
                                Delete
                              </button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {canWrite ? (
                  <button type="button" className="btn-link mt-3" onClick={() => openForm(selected)}>
                    + Add on this date
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <svg className="h-10 w-10 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10h18M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2M14 17h2" strokeLinecap="round" />
                </svg>
                <p id="day-heading" className="text-sm font-medium text-slate-700">
                  Click a date to see its holidays
                </p>
              </div>
            )}
          </section>

          <section className="card p-6" aria-labelledby="registry-heading">
            <h3 id="registry-heading" className="text-lg font-bold">
              Holiday Registry
            </h3>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {visibleRows.length} {visibleRows.length === 1 ? 'holiday' : 'holidays'} defined
              <span className="font-normal">
                {' '}
                · {MONTH_NAMES[month.month - 1]} {month.year}
              </span>
            </p>
            {state.loading ? (
              <p className="py-8 text-center text-sm text-slate-500">Loading entries…</p>
            ) : visibleRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-700">No holidays in registry</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {visibleRows.map(({ entry, date }) => {
                  const category = typeCategory(entry.exception_type);
                  return (
                    <li key={`${entry.exception_id}-${date}`} className="flex items-center gap-3 py-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${category.dot}`} aria-hidden="true" />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => pickDay(date, true)}>
                        <span className="block truncate text-sm font-semibold text-slate-900">{entry.description || typeLabel(entry.exception_type)}</span>
                        <span className="block text-xs text-slate-500">
                          {date} · {typeLabel(entry.exception_type)} · {officeName(entry.office_id)}
                        </span>
                      </button>
                      {canWrite ? (
                        <button type="button" className="btn-link" onClick={() => setConfirm(entry)}>
                          Delete
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <section className="card p-4 sm:p-6" aria-label="Month view">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-2xl" aria-live="polite">
              <span className="font-bold">{MONTH_NAMES[month.month - 1]}</span> <span className="font-normal text-slate-500">{month.year}</span>
            </h3>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                onClick={() => goToMonth(prev)}
                aria-label="Previous month"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                onClick={() => goToMonth(next)}
                aria-label="Next month"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M8 4l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <ul className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">
            {TYPE_CATEGORIES.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
                {c.label}
              </li>
            ))}
          </ul>

          <div className="mt-4 grid grid-cols-7 border-b border-slate-200 pb-2 text-center text-[11px] font-bold uppercase tracking-wide">
            {DAY_NAMES.map((d, index) => (
              <div key={d} className={index === 0 ? 'text-red-600' : 'text-slate-500'}>
                {d.slice(0, 3)}
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-7 overflow-hidden rounded-xl border border-slate-200">
            {cells.map((cell, index) => {
              const entries = cell.inMonth ? (byDate.get(cell.date) ?? []) : [];
              const categories = TYPE_CATEGORIES.filter((c) => entries.some((e) => typeCategory(e.exception_type).id === c.id));
              const isSelected = cell.date === selected;
              const tone = isSelected ? 'bg-maroon-50 ring-2 ring-inset ring-maroon-800' : cell.inMonth ? 'bg-white hover:bg-slate-50' : 'bg-slate-50 hover:bg-slate-100';
              const numberTone = !cell.inMonth ? 'text-slate-400' : index % 7 === 0 ? 'text-red-600' : 'text-slate-900';
              return (
                <button
                  key={cell.date}
                  type="button"
                  onClick={() => pickDay(cell.date, cell.inMonth)}
                  aria-pressed={isSelected}
                  className={`flex min-h-14 flex-col items-start border-b border-r border-slate-100 p-1.5 text-left text-xs sm:min-h-20 sm:p-2 ${tone}`}
                  aria-label={`${cell.date}${entries.length ? `: ${entries.map((e) => e.description || typeLabel(e.exception_type)).join(', ')}` : ''}`}
                >
                  <span className={`font-semibold ${numberTone} ${cell.date === today ? 'rounded-full bg-gold-400/40 px-1.5' : ''}`}>{cell.day}</span>
                  {categories.length > 0 ? (
                    <span className="mt-1 flex gap-1">
                      {categories.map((c) => (
                        <span key={c.id} className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
                      ))}
                    </span>
                  ) : null}
                  {entries.length > 0 ? (
                    <span className="mt-1 hidden w-full truncate text-[10px] text-slate-600 sm:block">{entries[0].description || typeLabel(entries[0].exception_type)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {canWrite ? (
        <>
          <Modal
            open={form !== null}
            title="Add holiday or suspension"
            onClose={saving ? undefined : () => setForm(null)}
            footer={
              <>
                <button type="button" className="btn-secondary" onClick={() => setForm(null)} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" form="exception-form" className="btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </>
            }
          >
            {form ? (
              <form id="exception-form" onSubmit={save} className="space-y-4">
                <ErrorBanner message={formError} />
                <ErrorBanner message={offices.error ? `Offices could not be loaded: ${offices.error}` : null} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="exception_date">
                      Date
                    </label>
                    <input id="exception_date" type="date" className="input" value={form.exception_date} onChange={(e) => setForm({ ...form, exception_date: e.target.value })} required />
                    {fieldErrors.exception_date ? <p className="mt-1 text-xs text-red-700">{fieldErrors.exception_date}</p> : null}
                  </div>
                  <div>
                    <label className="label" htmlFor="exception_type">
                      Type
                    </label>
                    <select id="exception_type" className="input" value={form.exception_type} onChange={(e) => setType(e.target.value)}>
                      {EXCEPTION_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    {fieldErrors.exception_type ? <p className="mt-1 text-xs text-red-700">{fieldErrors.exception_type}</p> : null}
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="description">
                    Description
                  </label>
                  <input id="description" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={200} />
                  {fieldErrors.description ? <p className="mt-1 text-xs text-red-700">{fieldErrors.description}</p> : null}
                </div>
                <div>
                  <label className="label" htmlFor="office_id">
                    Scope
                  </label>
                  <select id="office_id" className="input" value={form.office_id} onChange={(e) => setForm({ ...form, office_id: e.target.value })}>
                    <option value="">Campus-wide (all offices)</option>
                    {offices.items
                      .filter((o) => o.is_active)
                      .map((o) => (
                        <option key={o.office_id} value={o.office_id}>
                          {o.office_code} - {o.office_name}
                        </option>
                      ))}
                  </select>
                  {fieldErrors.office_id ? <p className="mt-1 text-xs text-red-700">{fieldErrors.office_id}</p> : null}
                </div>
                <div>
                  <label className="label" htmlFor="suspended_from">
                    Suspended from (HH:MM, 24-hour; leave empty for the whole day)
                  </label>
                  <input
                    id="suspended_from"
                    className="input w-32"
                    placeholder="HH:MM"
                    inputMode="numeric"
                    maxLength={5}
                    value={form.suspended_from}
                    onChange={(e) => setForm({ ...form, suspended_from: e.target.value })}
                  />
                  {fieldErrors.suspended_from ? <p className="mt-1 text-xs text-red-700">{fieldErrors.suspended_from}</p> : null}
                </div>
                <div>
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={form.is_recurring} disabled={form.exception_type === 'SUSPENSION'} onChange={(e) => setForm({ ...form, is_recurring: e.target.checked })} />
                    Repeats every year on this date
                  </label>
                  {form.exception_type === 'SUSPENSION' ? <p className="mt-1 text-xs text-slate-500">Suspensions cannot be recurring.</p> : null}
                  {fieldErrors.is_recurring ? <p className="mt-1 text-xs text-red-700">{fieldErrors.is_recurring}</p> : null}
                </div>
              </form>
            ) : null}
          </Modal>

          <ConfirmDialog
            open={confirm !== null}
            title="Delete entry?"
            message={
              confirm
                ? `${typeLabel(confirm.exception_type)} on ${confirm.exception_date}${confirm.description ? ` (${confirm.description})` : ''} will be removed.${
                    confirm.is_recurring ? ' This entry repeats every year: it is removed for every year, not only the one shown.' : ''
                  } Deadlines computed afterwards will use the new calendar.`
                : ''
            }
            confirmLabel="Delete"
            danger
            busy={saving}
            onConfirm={remove}
            onCancel={() => setConfirm(null)}
          />
        </>
      ) : null}
    </div>
  );
}
