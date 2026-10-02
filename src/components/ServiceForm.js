'use client';

import { CLASSIFICATIONS, DURATION_UNITS, TRANSACTION_TYPES } from '../lib/client/catalogue.js';

export const EMPTY_SERVICE_FORM = {
  office_id: '',
  service_code: '',
  service_name: '',
  classification: 'SIMPLE',
  transaction_type: 'G2C',
  processing_steps: '',
  duration_value: '',
  duration_unit: 'WORKING_DAYS',
  effective_from: '',
  charter_reference: '',
};

export function serviceToForm(service) {
  return {
    ...EMPTY_SERVICE_FORM,
    office_id: service.office_id,
    service_code: service.service_code,
    service_name: service.service_name,
    classification: service.classification,
    transaction_type: service.transaction_type,
    processing_steps: service.processing_steps ?? '',
  };
}

/** Request body for POST (with standard) or PUT (without). */
export function formToBody(form, withStandard) {
  const body = {
    office_id: form.office_id,
    service_code: form.service_code,
    service_name: form.service_name,
    classification: form.classification,
    transaction_type: form.transaction_type,
    processing_steps: form.processing_steps.trim() === '' ? null : form.processing_steps,
  };
  if (withStandard) {
    body.standard = {
      duration_value: Number(form.duration_value),
      duration_unit: form.duration_unit,
      effective_from: form.effective_from,
      charter_reference: form.charter_reference,
    };
  }
  return body;
}

function FieldError({ errors, name }) {
  return errors?.[name] ? <p className="mt-1 text-xs text-red-700">{errors[name]}</p> : null;
}

/** Add / edit service fields. The First Standard section only appears when adding. */
export default function ServiceForm({ id, form, setForm, errors, offices, isNew, onSubmit }) {
  const set = (name) => (e) => setForm({ ...form, [name]: e.target.value });
  // errors from the API may be keyed "standard.duration_value" or "duration_value"
  const err = (name) => errors?.[name] ?? errors?.[`standard.${name}`];
  const errFor = (name) => ({ [name]: err(name) });
  return (
    <form id={id} onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor={`${id}-office`}>
          Office
        </label>
        <select id={`${id}-office`} className="input" value={form.office_id} onChange={set('office_id')} required>
          <option value="">Select an office</option>
          {offices.map((o) => (
            <option key={o.office_id} value={o.office_id}>
              {o.office_code} - {o.office_name}
            </option>
          ))}
        </select>
        <FieldError errors={errors} name="office_id" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor={`${id}-code`}>
            Service code
          </label>
          <input id={`${id}-code`} className="input" placeholder="OFFICE-ABBR-001" value={form.service_code} onChange={set('service_code')} required maxLength={40} />
          <FieldError errors={errors} name="service_code" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`${id}-name`}>
            Service name
          </label>
          <input id={`${id}-name`} className="input" value={form.service_name} onChange={set('service_name')} required minLength={3} maxLength={100} />
          <FieldError errors={errors} name="service_name" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${id}-class`}>
            Classification
          </label>
          <select id={`${id}-class`} className="input" value={form.classification} onChange={set('classification')}>
            {CLASSIFICATIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <FieldError errors={errors} name="classification" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-type`}>
            Transaction type
          </label>
          <select id={`${id}-type`} className="input" value={form.transaction_type} onChange={set('transaction_type')}>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <FieldError errors={errors} name="transaction_type" />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-steps`}>
          Procedure steps (reference only, plain text)
        </label>
        <textarea id={`${id}-steps`} className="input" rows={5} value={form.processing_steps} onChange={set('processing_steps')} maxLength={5000} />
        <FieldError errors={errors} name="processing_steps" />
      </div>

      {isNew ? (
        <fieldset className="rounded-lg border border-slate-200 p-4">
          <legend className="px-2 text-sm font-semibold text-maroon-800">First Standard</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`${id}-dv`}>
                Duration value
              </label>
              <input id={`${id}-dv`} type="number" min={1} step={1} className="input" value={form.duration_value} onChange={set('duration_value')} required />
              <FieldError errors={errFor('duration_value')} name="duration_value" />
            </div>
            <div>
              <label className="label" htmlFor={`${id}-du`}>
                Duration unit
              </label>
              <select id={`${id}-du`} className="input" value={form.duration_unit} onChange={set('duration_unit')}>
                {DURATION_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
              <FieldError errors={errFor('duration_unit')} name="duration_unit" />
            </div>
            <div>
              <label className="label" htmlFor={`${id}-ef`}>
                Effective from
              </label>
              <input id={`${id}-ef`} type="date" className="input" value={form.effective_from} onChange={set('effective_from')} required />
              <FieldError errors={errFor('effective_from')} name="effective_from" />
            </div>
            <div>
              <label className="label" htmlFor={`${id}-cr`}>
                Charter reference
              </label>
              <input id={`${id}-cr`} className="input" value={form.charter_reference} onChange={set('charter_reference')} required maxLength={200} />
              <FieldError errors={errFor('charter_reference')} name="charter_reference" />
            </div>
          </div>
        </fieldset>
      ) : null}
    </form>
  );
}
