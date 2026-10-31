// `npm run mocks` starts a mock FMS and a mock Audit as real processes.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe('mocks/index.js', () => {
  it('serves the FMS mock and the Audit mock on the configured ports', async () => {
    const [fmsPort, auditPort] = [await freePort(), await freePort()];
    let timer;
    const child = spawn(process.execPath, ['mocks/index.js'], {
      env: { ...process.env, MOCK_FMS_PORT: String(fmsPort), MOCK_AUDIT_PORT: String(auditPort), SERVICE_KEY: 'k', CCMS_CALENDAR_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('Mock Audit')) resolve();
        });
        child.on('exit', () => reject(new Error('mocks exited early')));
        timer = setTimeout(() => reject(new Error('mocks did not start')), 10000);
      });
      const fms = await (await fetch(`http://127.0.0.1:${fmsPort}/received`)).json();
      const audit = await (await fetch(`http://127.0.0.1:${auditPort}/received`)).json();
      assert.equal(fms.system, 'FMS');
      assert.equal(audit.system, 'AUDIT');
      const push = await fetch(`http://127.0.0.1:${auditPort}/anything`, { method: 'POST', headers: { 'x-service-key': 'k' }, body: '{"sync_id":"abc"}' });
      assert.equal(push.status, 200);
      assert.equal((await (await fetch(`http://127.0.0.1:${auditPort}/received`)).json()).count, 1);
    } finally {
      clearTimeout(timer);
      child.kill('SIGTERM');
    }
  });
});
