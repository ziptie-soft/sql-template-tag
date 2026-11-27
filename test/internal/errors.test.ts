import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SqlDialectError } from '../../src/internal/errors.js';

void describe('SqlDialectError', async () => {
  await it('includes dialect and reason without a value index', () => {
    const error = new SqlDialectError('pinot', 'invalid identifier');

    assert.ok(error instanceof SqlDialectError);
    assert.ok(error instanceof TypeError);
    assert.strictEqual(error.name, 'SqlDialectError');
    assert.strictEqual(error.dialect, 'pinot');
    assert.strictEqual(error.index, undefined);
    assert.strictEqual(error.reason, 'invalid identifier');
    assert.strictEqual(error.message, '[pinot] invalid identifier');
  });

  await it('includes the value index when supplied', () => {
    const error = new SqlDialectError('snowflake', 'invalid value', 0);

    assert.ok(error instanceof TypeError);
    assert.strictEqual(error.dialect, 'snowflake');
    assert.strictEqual(error.index, 0);
    assert.strictEqual(error.reason, 'invalid value');
    assert.strictEqual(error.message, '[snowflake] invalid value (value #0)');
  });
});
