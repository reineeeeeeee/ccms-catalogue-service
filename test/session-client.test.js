import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

// The browser session client (src/lib/client/session.js) with a fake window, sessionStorage and fetch.
const claims = { sub: 'u1', employee_no: 'E-1', full_name: 'Test User', role: 'SUPER_ADMIN', office_id: null };
const jwt = () => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const tokenResponse = (expiresIn = 900) => new Response(JSON.stringify({ access_token: jwt(), expires_in: expiresIn }), { status: 200 });

let store;
let calls;
let nextResponses;
let counter = 0;
let jar;

beforeEach(() => {
  store = new Map();
  calls = [];
  nextResponses = [];
  jar = new Map();
  globalThis.document = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(line) {
      const [pair, ...attrs] = line.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => a === 'max-age=0')) jar.delete(k);
      else jar.set(k, v);
    },
  };
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { pathname: '/services', assign: (url) => calls.push(`assign ${url}`) },
  };
  globalThis.fetch = async (url) => {
    calls.push(`fetch ${url}`);
    const next = nextResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response('{}', { status: 500 });
  };
});

// A fresh copy of the module is what a new page load sees (module state is lost, sessionStorage stays).
const freshPage = () => import(`../src/lib/client/session.js?page=${++counter}`);

describe('session client', () => {
  it('keeps the access token across page loads without calling Identity', async () => {
    const first = await freshPage();
    nextResponses.push(tokenResponse());
    await first.signIn('a@b.c', 'pw');
    calls.length = 0;
    const second = await freshPage();
    const user = await second.refreshSession();
    assert.equal(user.role, 'SUPER_ADMIN');
    assert.deepEqual(calls, [], 'a still-valid token needs no call to Identity');
    assert.ok(await second.getAccessToken());
  });

  it('ignores an expired saved token and asks Identity', async () => {
    store.set('ccms_access', JSON.stringify({ token: jwt(), expiresAt: Date.now() - 1000 }));
    const page = await freshPage();
    nextResponses.push(new Response('{}', { status: 401 }));
    assert.equal(await page.refreshSession(), null);
    assert.deepEqual(calls, ['fetch /api/identity/auth/refresh']);
    assert.equal(store.has('ccms_access'), false);
  });

  it('an expired or revoked refresh token (401) signs the user out', async () => {
    const page = await freshPage();
    nextResponses.push(new Response('{}', { status: 401 }));
    assert.equal(await page.refreshSession(), null);
  });

  it('Identity down (502) shows a clear message instead of signing out', async () => {
    const page = await freshPage();
    nextResponses.push(new Response('{}', { status: 502 }));
    await assert.rejects(page.refreshSession(), (e) => e.code === 'IDENTITY_UNAVAILABLE' && /sign-in service is not available/.test(e.message));
    nextResponses.push(new Error('connect ECONNREFUSED'));
    await assert.rejects(page.refreshSession(), (e) => e.code === 'IDENTITY_UNAVAILABLE');
    assert.ok(!calls.some((c) => c.startsWith('assign')), 'no redirect to a sign-in page that is also down');
  });

  it('with Identity down, a token that is close to expiry but still valid keeps working', async () => {
    store.set('ccms_access', JSON.stringify({ token: jwt(), expiresAt: Date.now() + 10_000 }));
    jar.set('ccms_signed_in', '1');
    const page = await freshPage();
    nextResponses.push(new Response('{}', { status: 503 }));
    assert.ok(await page.getAccessToken());
  });

  it('with Identity down and the token expired, the user is told, not redirected', async () => {
    const page = await freshPage();
    nextResponses.push(new Response('{}', { status: 502 }));
    await assert.rejects(page.getAccessToken(), (e) => e.code === 'IDENTITY_UNAVAILABLE');
  });

  it('signing out in another app on the same host makes this one drop its saved token', async () => {
    const first = await freshPage();
    nextResponses.push(tokenResponse());
    await first.signIn('a@b.c', 'pw');
    jar.delete('ccms_signed_in'); // what a sign-out in another app (another port, same host) does
    calls.length = 0;
    const second = await freshPage();
    nextResponses.push(new Response('{}', { status: 401 }));
    assert.equal(await second.refreshSession(), null, 'no saved token is trusted; Identity says the session is gone');
    assert.ok(calls.some((c) => c.includes('/auth/refresh')));
  });

  it('sign out clears the saved token', async () => {
    const page = await freshPage();
    nextResponses.push(tokenResponse());
    await page.signIn('a@b.c', 'pw');
    assert.ok(store.has('ccms_access'));
    nextResponses.push(new Response(null, { status: 204 }));
    await page.signOut();
    assert.equal(store.has('ccms_access'), false);
    assert.ok(calls.includes('assign /'));
  });

  it('sign out goes to the sign-in page to finish the job when Identity could not be reached', async () => {
    const page = await freshPage();
    nextResponses.push(tokenResponse());
    await page.signIn('a@b.c', 'pw');
    nextResponses.push(new Response('not found', { status: 404 }));
    await page.signOut();
    assert.equal(store.has('ccms_access'), false);
    assert.ok(calls.includes('assign /login?signed_out=1'));
  });
});
