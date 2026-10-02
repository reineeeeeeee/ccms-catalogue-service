'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { landingForRole, navForRole } from 'ccms-shared/nav';
import { ROLE_LABELS } from 'ccms-shared/roles';
import { BRAND } from '../lib/brand.js';
import { pageHref } from '../lib/client/links.js';
import { getAccessToken, redirectToLogin, refreshSession, signOut } from '../lib/client/session.js';
import ErrorBanner from './ErrorBanner.js';
import BrandMark from './BrandMark.js';

function initials(name) {
  return (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/**
 * Layout for every signed-in page: header with the user and Sign out, and navigation that shows
 * only the current role's pages. Pass allowedRoles to keep other roles off a page (the API still
 * enforces access on the server).
 */
export default function AppShell({ title, subtitle, allowedRoles, children }) {
  const pathname = usePathname();
  const [state, setState] = useState({ status: 'loading', user: null, message: null });
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((user) => {
        if (cancelled) return;
        if (!user) redirectToLogin();
        else setState({ status: 'ready', user, message: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', user: null, message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the session alive quietly and notice a revoked one.
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const timer = setInterval(async () => {
      try {
        if (!(await getAccessToken())) redirectToLogin();
      } catch {
        /* offline: try again on the next tick */
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [state.status]);

  if (state.status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Checking your session…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <ErrorBanner message={state.message} />
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  const { user } = state;
  const nav = navForRole(user.role);
  const sections = [...new Set(nav.map((item) => item.section))];
  const allowed = !allowedRoles || allowedRoles.includes(user.role);

  return (
    <div className="min-h-screen lg:flex">
      <aside className={`${menuOpen ? 'block' : 'hidden'} w-full shrink-0 bg-maroon-900 text-white lg:block lg:min-h-screen lg:w-64`}>
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
          <BrandMark size={40} />
          <div>
            <p className="text-sm font-bold leading-tight">{BRAND.campus}</p>
            <p className="text-xs text-white/70">{BRAND.system}</p>
          </div>
        </div>
        <nav className="px-3 py-4" aria-label="Main navigation">
          {sections.map((section) => (
            <div key={section} className="mb-4">
              <p className="px-3 pb-2 text-[11px] font-bold uppercase tracking-widest text-gold-400">{section}</p>
              {nav
                .filter((item) => item.section === section)
                .map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <a
                      key={item.href}
                      href={pageHref(item.href)}
                      aria-current={active ? 'page' : undefined}
                      className={`mb-1 block rounded-md border-l-4 px-3 py-2 text-sm font-medium ${
                        active ? 'border-gold-500 bg-white/10 text-white' : 'border-transparent text-white/80 hover:bg-white/5'
                      }`}
                    >
                      {item.label}
                    </a>
                  );
                })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-8">
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary px-3 py-1.5 lg:hidden" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation">
              Menu
            </button>
            <span className="text-sm text-slate-500">{title}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold text-slate-900">{user.fullName}</p>
              <p className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-maroon-800 text-sm font-bold text-white" aria-hidden="true">
              {initials(user.fullName)}
            </div>
            <button type="button" className="btn-secondary px-3 py-1.5" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-8">
          <div className="mb-6">
            <h1 className="text-3xl">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
          </div>
          {allowed ? (
            typeof children === 'function' ? children(user) : children
          ) : (
            <div className="card p-6">
              <p className="text-sm text-slate-700">Your role does not have access to this page.</p>
              <a className="btn-primary mt-4" href={pageHref(landingForRole(user.role))}>
                Go to my home
              </a>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
