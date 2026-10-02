import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import httpProxy from 'http-proxy';
import { bearerToken } from './auth.js';
import { isPublicApi, resolveRoute, serviceTargets } from './routes.js';

const CORRELATION = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

const UNAVAILABLE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CCMS | Not available</title><style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#475569;margin:.25rem 0}a{display:inline-block;margin-top:1rem;background:#6b0f0f;color:#fff;padding:.5rem 1rem;border-radius:.5rem;text-decoration:none}</style></head><body><main><h1>This part of CCMS is not available right now</h1><p>The service that owns this page is not responding. Other parts of the system keep working.</p><p>Please try again in a few minutes.</p><a href="/">Back to home</a></main></body></html>`;

function errorBody(code, message, correlationId) {
  return { error: { code, message, details: null, correlation_id: correlationId, timestamp: new Date().toISOString() } };
}

function sendError(res, status, code, message, correlationId, extraHeaders = {}) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(errorBody(code, message, correlationId));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', [CORRELATION]: correlationId, ...extraHeaders });
  res.end(body);
}

/**
 * Builds the embedded gateway (this app's own copy of the CCMS gateway; there is no separate gateway repo).
 * Requests for the services this app does not own are passed to those services. Everything else, including
 * paths the routing table does not know (Next.js internals), goes to this app's own Next.js server (`self`).
 *   targets      { serviceName: 'http://host:port' }
 *   requireTls   refuse or redirect anything that did not arrive over HTTPS (all deployed environments)
 *   trustProxy   believe X-Forwarded-Proto from a TLS-terminating load balancer
 *   tls          { cert, key } to terminate TLS in the gateway itself
 *   tokenCheck   async (token) -> { ok } | { ok: false, status, code, message }; when set, every /api route that is
 *                not public needs a valid token (the gateway never checks roles or offices)
 */
export function createGateway({ targets = serviceTargets(), self, requireTls = false, trustProxy = false, tls, tokenCheck } = {}) {
  const proxy = httpProxy.createProxyServer({ xfwd: true, changeOrigin: false, ws: true });

  proxy.on('error', (_err, req, res) => {
    const correlationId = req.headers[CORRELATION];
    // For websockets `res` is a socket; just close it.
    if (typeof res?.writeHead !== 'function') return res?.destroy?.();
    // A person opening a page of a service that is down gets a readable page, not JSON.
    const wantsPage = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html') && !String(req.url).startsWith('/api/');
    if (wantsPage && !res.headersSent) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', [CORRELATION]: correlationId, 'retry-after': '30' });
      return res.end(UNAVAILABLE_PAGE);
    }
    sendError(res, 502, 'SERVICE_UNAVAILABLE', 'The service is not available right now. Please try again.', correlationId);
  });

  const isSecure = (req) => Boolean(req.socket.encrypted) || (trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https');

  function prepare(req) {
    // Keep a caller's correlation id when it is safe, otherwise start a new one; forward it unchanged.
    const incoming = req.headers[CORRELATION];
    req.headers[CORRELATION] = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    // A browser must never be able to present the service-to-service key through the gateway.
    delete req.headers['x-service-key'];
    return req.headers[CORRELATION];
  }

  async function handler(req, res) {
    const correlationId = prepare(req);
    const url = req.url ?? '/';

    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', [CORRELATION]: correlationId });
      return res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
    }

    if (requireTls && !isSecure(req)) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const host = req.headers.host ?? 'localhost';
        res.writeHead(308, { location: `https://${host}${url}`, [CORRELATION]: correlationId });
        return res.end();
      }
      return sendError(res, 403, 'HTTPS_REQUIRED', 'This address only accepts HTTPS.', correlationId);
    }

    const route = resolveRoute(url, targets, req.method);
    if (route?.blocked) return sendError(res, 404, 'ROUTE_NOT_FOUND', 'Not found', correlationId);
    if (!route) {
      // Not one of the routed paths: this app's own Next.js server answers (static files, health, 404 page).
      res.setHeader(CORRELATION, correlationId);
      return proxy.web(req, res, { target: self });
    }

    if (tokenCheck && route.path.startsWith('/api/') && !isPublicApi(route.service, route.path)) {
      const token = bearerToken(req.headers);
      if (!token) return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required', correlationId);
      let result;
      try {
        result = await tokenCheck(token);
      } catch {
        result = { ok: false, status: 503, code: 'AUTH_UNAVAILABLE', message: 'Cannot verify your session right now, try again' };
      }
      if (!result.ok) return sendError(res, result.status, result.code, result.message, correlationId);
    }

    if (requireTls) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    res.setHeader(CORRELATION, correlationId);
    req.url = route.path;
    proxy.web(req, res, { target: targets[route.service] });
  }

  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);

  // Dev servers use a websocket for hot reload; it goes through the same asset prefix.
  server.on('upgrade', (req, socket, head) => {
    prepare(req);
    const route = resolveRoute(req.url ?? '/', targets, req.method);
    if (route?.blocked || (requireTls && !isSecure(req))) return socket.destroy();
    // Hot-reload sockets of this app (unprefixed) go to its own Next.js server.
    if (!route || !req.url.startsWith('/_ccms/')) return proxy.ws(req, socket, head, { target: self });
    // Next's dev server expects the hot-reload socket at its prefixed path, so the URL is kept as is.
    proxy.ws(req, socket, head, { target: targets[route.service] });
  });

  server.on('close', () => proxy.close());
  return server;
}
