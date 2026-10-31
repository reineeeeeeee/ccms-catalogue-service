// TT1: the engine is a pure module. It must not read the clock, the environment, the network or the
// database, so the same inputs always give the same answer.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (file) => readFileSync(new URL(`../../src/lib/calendar/engine/${file}`, import.meta.url), 'utf8');

describe('engine purity', () => {
  for (const file of ['working-time.js', 'recurrence.js']) {
    it(`${file} imports nothing but ccms-shared time constants and the engine's own modules`, () => {
      const imports = [...read(file).matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
      for (const source of imports) assert.ok(source === 'ccms-shared' || source.startsWith('./'), `unexpected import ${source}`);
    });

    it(`${file} never reads the clock, environment, network or local time`, () => {
      const code = read(file)
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      for (const banned of [/Date\.now\(/, /new Date\(\)/, /process\./, /fetch\(/, /require\(/, /\.(get|set)(Day|Date|Hours|Minutes|FullYear|Month)\(/, /Intl\./, /Math\.random/]) {
        assert.ok(!banned.test(code), `${file} uses ${banned}`);
      }
    });
  }
});
