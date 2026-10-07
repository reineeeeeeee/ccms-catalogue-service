// A small mock of FMS or Audit (TT2). Runs without the real systems:
//   POST <any path>   receives a calendar push. Answers 200, or 503 while the mock is switched to fail,
//                     or 401 when the shared service key is wrong.
//   GET  /received    every push accepted so far, plus the current mode
//   DELETE /received  forget the recorded pushes
//   POST /mode        { "fail": true | false } switch failing on or off
//   POST /ack         (Audit only) { "sync_id": "..." } sends Audit's acknowledgment to CCMS /api/sync/ack
import { createServer } from 'node:http';

const CONTROL = new Set(['/received', '/mode', '/ack']);

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(''));
  });
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

/**
 * name         'FMS' or 'AUDIT'
 * serviceKey   the shared key the mock expects on pushes (and sends on /ack); unset = do not check
 * ccmsUrl      base URL of the merged Core service (Catalogue + Calendar), for /ack, for example http://127.0.0.1:3003
 */
export function createMockServer({ name, serviceKey, ccmsUrl = 'http://127.0.0.1:3003', fetchImpl = fetch }) {
  const state = { fail: false, received: [], rejected: 0 };

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url, 'http://mock');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await readBody(request);

    if (path === '/received' && request.method === 'GET') {
      return send(200, { system: name, fail: state.fail, rejected: state.rejected, count: state.received.length, items: state.received });
    }
    if (path === '/received' && request.method === 'DELETE') {
      state.received = [];
      state.rejected = 0;
      return send(200, { cleared: true });
    }
    if (path === '/mode' && request.method === 'POST') {
      const body = parseJson(text);
      if (!body || typeof body.fail !== 'boolean') return send(400, { error: 'Send { "fail": true } or { "fail": false }' });
      state.fail = body.fail;
      return send(200, { system: name, fail: state.fail });
    }
    if (path === '/ack' && request.method === 'POST') {
      if (name !== 'AUDIT') return send(404, { error: 'FMS has no acknowledgment link' });
      const body = parseJson(text);
      if (!body || typeof body.sync_id !== 'string' || !body.sync_id) return send(400, { error: 'sync_id is required' });
      try {
        const upstream = await fetchImpl(`${ccmsUrl.replace(/\/$/, '')}/api/sync/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-key': serviceKey ?? '' },
          body: JSON.stringify({ sync_id: body.sync_id }),
        });
        return send(200, { ccms_status: upstream.status, ccms_response: parseJson(await upstream.text()) });
      } catch (err) {
        return send(502, { error: `Could not reach CCMS: ${err.message}` });
      }
    }
    if (CONTROL.has(path)) return send(405, { error: 'Method not allowed' });

    // Anything else is a push.
    if (request.method !== 'POST') return send(404, { error: 'Not found' });
    if (state.fail) {
      state.rejected += 1;
      return send(503, { error: `${name} mock is switched to fail` });
    }
    if (serviceKey && request.headers['x-service-key'] !== serviceKey) {
      state.rejected += 1;
      return send(401, { error: 'Invalid service key' });
    }
    const body = parseJson(text);
    if (!body) return send(400, { error: 'Body must be JSON' });
    state.received.push({ received_at: new Date().toISOString(), path, correlation_id: request.headers['x-correlation-id'] ?? null, body });
    return send(200, { received: true, sync_id: body.sync_id ?? null });
  });

  return {
    server,
    state,
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
