import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { GET } from '../src/app/api/health/route.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('health endpoint', () => {
  it('reports ok and echoes a correlation id', async () => {
    const response = await GET(new Request('http://localhost/api/health'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: pkg.ccms.service });
    assert.ok(response.headers.get('x-correlation-id'));
  });
});
