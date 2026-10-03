'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import ErrorBanner from '../../../components/ErrorBanner.js';
import PublicHeader from '../../../components/PublicHeader.js';
import { classificationLabel, publicFetch } from '../../../lib/client/catalogue.js';

export default function PublicServiceDetail() {
  const { id } = useParams();
  const [state, setState] = useState({ loading: true, service: null, error: null });

  useEffect(() => {
    let cancelled = false;
    publicFetch(`/api/catalogue/public/services/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setState({ loading: false, service: data.service, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, service: null, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const service = state.service;
  return (
    <div className="min-h-screen">
      <PublicHeader />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
        <a href="/" className="btn-link">
          &larr; Back to all services
        </a>
        <ErrorBanner message={state.error} />
        {state.loading ? <p className="text-sm text-slate-500">Loading service…</p> : null}
        {service ? (
          <>
            <div className="card p-6">
              <h1 className="text-2xl">{service.service_name}</h1>
              <p className="mt-1 text-sm text-slate-600">{service.office_name}</p>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="label">Classification</dt>
                  <dd className="text-sm">{classificationLabel(service.classification)}</dd>
                </div>
                <div>
                  <dt className="label">Standard</dt>
                  <dd className="text-sm font-semibold">{service.standard_text}</dd>
                </div>
                <div>
                  <dt className="label">Fees</dt>
                  <dd className="text-sm">{service.fees ?? 'No fee information published.'}</dd>
                </div>
                <div>
                  <dt className="label">Who may avail</dt>
                  <dd className="text-sm">{service.who_may_avail ?? 'Not specified.'}</dd>
                </div>
              </dl>
            </div>

            <div className="card p-6">
              <h2 className="text-lg">Requirements checklist</h2>
              {service.documents?.length ? (
                <ul className="mt-3 divide-y divide-slate-100">
                  {service.documents.map((doc, index) => (
                    <li key={index} className="py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{doc.document_name}</span>
                        {doc.is_mandatory ? <span className="badge bg-maroon-50 text-maroon-800">Mandatory</span> : <span className="badge-inactive">Optional</span>}
                      </div>
                      {doc.notes ? <p className="mt-1 whitespace-pre-wrap text-slate-600">{doc.notes}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No documents are listed for this service.</p>
              )}
            </div>

            <div className="card p-6">
              <h2 className="text-lg">Procedure steps</h2>
              {service.processing_steps ? (
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{service.processing_steps}</p>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No procedure steps have been published.</p>
              )}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
