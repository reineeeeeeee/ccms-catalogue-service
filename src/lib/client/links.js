// Each repo owns its own pages. Behind the gateway every page lives on one address, so links stay
// relative. When a repo runs on its own port, set NEXT_PUBLIC_IDENTITY_APP_URL (for example
// http://127.0.0.1:3001) so links to pages owned by the Identity repo (login, home) point at that app.
const OTHER_APP = (process.env.NEXT_PUBLIC_IDENTITY_APP_URL ?? '').replace(/\/$/, '');

// Pages this repo serves itself.
const OWN_PAGES = ['/offices', '/services', '/calendar', '/public'];

export function pageHref(href) {
  const path = href.split(/[?#]/)[0];
  const own = path === '/' || OWN_PAGES.some((page) => path === page || path.startsWith(`${page}/`));
  return own ? href : `${OTHER_APP}${href}`;
}
