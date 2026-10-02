import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Built from parts so this file does not itself contain the old prefix.
const OLD_PREFIX = ['ccc', 'ms-'].join('');
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('naming convention (TT1 AC3)', () => {
  it('uses ccms-{name}-service and ccms_{name}, never the old prefix', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.name, `ccms-${pkg.ccms.service}-service`);
    for (const file of ['package.json', '.env.example', 'README.md', 'next.config.js']) {
      assert.ok(!read(file).includes(OLD_PREFIX), `${file} uses the old prefix`);
    }
    const env = read('.env.example');
    assert.ok(env.includes(`/ccms_${pkg.ccms.service}`), 'database name should be ccms_{name}');
  });
});
