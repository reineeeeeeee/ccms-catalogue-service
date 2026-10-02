import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findLocalTimeUsage } from '../scripts/check-time-usage.mjs';

function project(source) {
  const dir = mkdtempSync(join(tmpdir(), 'ccms-time-'));
  writeFileSync(join(dir, 'a.js'), source);
  return dir;
}

describe('CI check for server-local date methods (TT6 AC2)', () => {
  it('flags getDay, getDate and setHours on local time', () => {
    const dir = project('const d = new Date();\nd.getDay();\nd.setHours(0);\nconst x = d.getDate();\n');
    assert.equal(findLocalTimeUsage([dir]).length, 3);
  });

  it('allows UTC methods, the Manila helpers, and explicitly exempted lines', () => {
    const dir = project(
      'd.getUTCDay();\nd.setUTCHours(0);\ntoManilaDate(d);\nd.getDay(); // ccms-allow-local-time\n',
    );
    assert.equal(findLocalTimeUsage([dir]).length, 0);
  });

  it('finds nothing in the shared library itself', () => {
    assert.deepEqual(findLocalTimeUsage([new URL('../src', import.meta.url).pathname]), []);
  });
});
