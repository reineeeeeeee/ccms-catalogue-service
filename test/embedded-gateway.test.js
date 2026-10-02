import { strict as assert } from 'node:assert';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../server/gateway/server.js';

// The embedded gateway with fake upstreams: this app ("self") and one other service.
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const upstream = (name) =>
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: name, url: req.url }));
  });

const servers = [];
let base;

before(async () => {
  const selfServer = upstream('self');
  const otherServer = upstream('other');
  servers.push(selfServer, otherServer);
  const selfPort = await listen(selfServer);
  const otherPort = await listen(otherServer);
  const targets = {
    identity: `http://127.0.0.1:${otherPort}`,
    catalogue: `http://127.0.0.1:${selfPort}`,
    calendar: `http://127.0.0.1:${selfPort}`,
    logs: 'http://127.0.0.1:1',
  };
  const gateway = createGateway({ targets, self: targets.catalogue });
  servers.push(gateway);
  base = `http://127.0.0.1:${await listen(gateway)}`;
});

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

const get = async (path, headers = {}) => {
  const response = await fetch(base + path, { headers });
  return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
};

describe('embedded gateway', () => {
  it('serves this app\'s own pages and assets from its own server', async () => {
    assert.equal(JSON.parse((await get('/offices')).text).from, 'self');
    assert.equal(JSON.parse((await get('/')).text).from, 'self');
    const asset = JSON.parse((await get('/_ccms/catalogue/_next/static/a.js')).text);
    assert.deepEqual(asset, { from: 'self', url: '/_next/static/a.js' });
  });

  it('passes another service\'s pages and APIs to that service', async () => {
    assert.equal(JSON.parse((await get('/login')).text).from, 'other');
    const api = JSON.parse((await get('/api/identity/auth/refresh')).text);
    assert.deepEqual(api, { from: 'other', url: '/api/auth/refresh' });
  });

  it('sends paths it does not route (Next.js internals) to this app', async () => {
    assert.deepEqual(JSON.parse((await get('/_next/static/x.js')).text), { from: 'self', url: '/_next/static/x.js' });
  });

  it('shows a readable page when another service is down, and JSON for API calls', async () => {
    const page = await get('/logs', { accept: 'text/html' });
    assert.equal(page.status, 503);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /not available right now/);
    const api = await get('/api/logs/health');
    assert.equal(api.status, 502);
    assert.equal(JSON.parse(api.text).error.code, 'SERVICE_UNAVAILABLE');
  });
});
