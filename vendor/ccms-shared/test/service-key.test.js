import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AppError, hasValidServiceKey, requireServiceKey } from '../src/index.js';

const KEY = 'a-very-long-shared-service-key';
const req = (headers) => new Request('http://localhost/internal', { headers });

describe('service-to-service key (TT4 AC3)', () => {
  it('accepts the correct key', () => {
    assert.doesNotThrow(() => requireServiceKey(req({ 'x-service-key': KEY }), KEY));
    assert.equal(hasValidServiceKey(req({ 'x-service-key': KEY }), KEY), true);
  });

  it('returns 401 without the key or with a wrong one', () => {
    for (const headers of [{}, { 'x-service-key': 'wrong' }, { 'x-service-key': KEY + 'x' }]) {
      try {
        requireServiceKey(req(headers), KEY);
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 401);
      }
    }
  });

  it('never treats a missing server key as a match', () => {
    assert.equal(hasValidServiceKey(req({ 'x-service-key': '' }), ''), false);
    assert.equal(hasValidServiceKey(req({}), undefined), false);
  });
});
