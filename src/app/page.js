'use client';

import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell.js';
import PublicHeader from '../components/PublicHeader.js';
import ErrorBanner from '../components/ErrorBanner.js';
import Pager from '../components/Pager.js';
import { BRAND } from '../lib/brand.js';
import { pageHref } from '../lib/client/links.js';
import { mightBeSignedIn, refreshSession } from '../lib/client/session.js';
import { classificationLabel, publicFetch, toQuery } from '../lib/client/catalogue.js';

const PAGE_SIZE = 12;
const API = '/api/catalogue/public/services';

// Quick links under the hero. Each one does something real on this page.
const TILES = [
  { title: 'Browse all services', text: 'See every service the University offers, A to Z.', action: 'browse', icon: 'M4 6h16M4 12h16M4 18h10' },
  { title: 'Find by office', text: 'Type an office name to see only its services.', action: 'search', icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6' },
  { title: 'What to bring', text: 'Open any service to see its requirements and steps.', action: 'browse', icon: 'M9 12l2 2 4-4M7 3h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z' },
];

function TileIcon({ path }) {
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-maroon-50 text-maroon-800">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
        <path d={path} />
      </svg>
    </span>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="ml-4 h-5 w-5 shrink-0 self-center text-slate-500" aria-hidden="true">
      <circle cx="9" cy="9" r="6" />
      <path d="M14 14l4 4" strokeLinecap="round" />
    </svg>
  );
}

// Search text, the page and the public services list, shared by the signed-out and signed-in home.
function useCatalogue() {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, items: [], total: 0, error: null });

  useEffect(() => {
    let cancelled = false;
    publicFetch(`${API}${toQuery({ search, page, page_size: PAGE_SIZE })}`)
      .then((data) => {
        if (!cancelled) setState({ loading: false, items: data.items ?? [], total: data.total ?? 0, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, items: [], total: 0, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [search, page]);

  function onSubmit(event) {
    event.preventDefault();
    setState((s) => ({ ...s, loading: true }));
    setPage(1);
    setSearch(input);
  }

  function onClear() {
    setInput('');
    setSearch('');
    setPage(1);
  }

  function browseAll() {
    setInput('');
    setSearch('');
    setPage(1);
    document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' });
  }

  return { input, setInput, search, page, setPage, state, onSubmit, onClear, browseAll };
}

function ServiceResults({ catalogue }) {
  const { search, page, setPage, state, onClear } = catalogue;
  return (
    <section id="services" className="scroll-mt-4">
      <h2 className="mb-4 text-2xl">{search ? `Results for "${search}"` : 'All services'}</h2>
      <ErrorBanner message={state.error} />
      {state.loading && !state.error ? <p className="text-sm text-slate-500">Loading services…</p> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-12 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-maroon-50 text-maroon-800">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7" aria-hidden="true">
              <path d={search ? 'M11 5a6 6 0 100 12 6 6 0 000-12zM20 20l-4-4' : 'M9 12l2 2 4-4M7 3h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z'} />
            </svg>
          </span>
          {search ? (
            <>
              <p className="mt-4 font-semibold text-slate-900">No services match {`"${search}"`}</p>
              <p className="mt-1 max-w-sm text-sm text-slate-600">Check the spelling, or try a shorter service or office name.</p>
              <button type="button" className="btn-primary mt-5" onClick={onClear}>
                Show all services
              </button>
            </>
          ) : (
            <>
              <p className="mt-4 font-semibold text-slate-900">No services are published yet</p>
              <p className="mt-1 max-w-sm text-sm text-slate-600">The list of services will appear here once the offices publish them. Please check back soon.</p>
            </>
          )}
        </div>
      ) : null}
      {state.items.length > 0 ? (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.items.map((item) => (
              <li key={item.service_id} className="card flex flex-col p-5">
                <h3 className="text-lg leading-snug">{item.service_name}</h3>
                <p className="mt-1 text-sm text-slate-600">{item.office_name}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="badge-role">{classificationLabel(item.classification)}</span>
                </div>
                <p className="mt-3 text-sm text-slate-700">
                  <span className="label inline">Standard</span> <span className="font-semibold">{item.standard_text}</span>
                </p>
                <a href={`/public/${encodeURIComponent(item.service_id)}`} className="btn-link mt-4">
                  View requirements
                </a>
              </li>
            ))}
          </ul>
          <div className="card mt-4">
            <Pager page={page} pageSize={PAGE_SIZE} total={state.total} onPage={setPage} />
          </div>
        </>
      ) : null}
    </section>
  );
}

// Signed in: the same Home inside the app shell (sidebar and top bar), without the hero.
function SignedInHome() {
  const catalogue = useCatalogue();
  const { input, setInput, onSubmit } = catalogue;
  return (
    <AppShell title="Home" subtitle="Find a service, see what to bring and how long it takes.">
      <form onSubmit={onSubmit} className="card mb-6 flex overflow-hidden" role="search">
        <label className="sr-only" htmlFor="home-search">
          Search services or offices
        </label>
        <SearchIcon />
        <input
          id="home-search"
          type="search"
          className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none"
          placeholder="Search by service or office name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="bg-maroon-800 px-6 text-sm font-semibold text-white hover:bg-maroon-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500">
          Search
        </button>
      </form>
      <ServiceResults catalogue={catalogue} />
    </AppShell>
  );
}

// Signed out: the public landing page. No session needed and no redirect. Staff use Staff Login.
function PublicHome() {
  const catalogue = useCatalogue();
  const { input, setInput, onSubmit, browseAll } = catalogue;

  function focusSearch() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.getElementById('public-search')?.focus();
  }

  return (
    <div className="min-h-screen">
      <section className="hero-bg relative text-white">
        <PublicHeader overlay />
        <div className="mx-auto max-w-3xl px-4 pb-24 pt-32 text-center sm:pt-40">
          <h1 className="font-serif text-3xl leading-tight text-white drop-shadow sm:text-5xl">
            Welcome to the
            <br />
            {BRAND.fullName}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-white/85">Find a service, see what to bring and how long it takes before you visit.</p>
          <form onSubmit={onSubmit} className="mx-auto mt-8 flex max-w-xl overflow-hidden rounded-md bg-white shadow-lg" role="search">
            <label className="sr-only" htmlFor="public-search">
              Search services or offices
            </label>
            <SearchIcon />
            <input
              id="public-search"
              type="search"
              className="min-w-0 flex-1 bg-transparent px-3 py-4 text-slate-900 placeholder:text-slate-500 focus:outline-none"
              placeholder="Search by service or office name"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" className="bg-gold-500 px-6 text-sm font-semibold text-maroon-950 hover:bg-gold-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-maroon-900">
              Search
            </button>
          </form>
        </div>
      </section>

      <section className="relative z-10 mx-auto -mt-10 max-w-6xl px-4" aria-label="Quick links">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TILES.map((tile) => (
            <li key={tile.title}>
              <button
                type="button"
                onClick={tile.action === 'browse' ? browseAll : focusSearch}
                className="card flex h-full w-full items-start gap-4 p-5 text-left transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-maroon-800"
              >
                <TileIcon path={tile.icon} />
                <span>
                  <span className="block font-semibold text-slate-900">{tile.title}</span>
                  <span className="mt-1 block text-sm text-slate-600">{tile.text}</span>
                </span>
              </button>
            </li>
          ))}
          <li>
            <a
              href={pageHref('/login')}
              className="card flex h-full items-start gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-maroon-800"
            >
              <TileIcon path="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" />
              <span>
                <span className="block font-semibold text-slate-900">Staff login</span>
                <span className="mt-1 block text-sm text-slate-600">For office and campus staff of the University.</span>
              </span>
            </a>
          </li>
        </ul>
      </section>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <ServiceResults catalogue={catalogue} />
      </main>
    </div>
  );
}

export default function Landing() {
  // 'checking' until we know; visitors with no session marker are public at once (no network call).
  const [mode, setMode] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    const check = mightBeSignedIn() ? refreshSession() : Promise.resolve(null);
    check
      .then((user) => {
        if (!cancelled) setMode(user ? 'signed-in' : 'public');
      })
      .catch(() => {
        if (!cancelled) setMode('public');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode === 'signed-in') return <SignedInHome />;
  if (mode === 'public') return <PublicHome />;
  return <div className="min-h-screen bg-maroon-900" aria-busy="true" />;
}
