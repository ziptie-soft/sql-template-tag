import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import sql from '../../src/index.js';
import { SqlDialectError } from '../../src/internal/errors.js';
import {
  assertBareIdentifier,
  assertShape,
  classify,
  formatBigint,
  formatDateUtc,
  formatNumber,
  hex,
  hexFallback,
  Kind,
  needsSpaceAfter,
  needsSpaceBefore,
  quoteIdentifier,
  quotePinotString,
  quoteSnowflakeString,
} from '../../src/internal/literals.js';

void describe('classify', async () => {
  await it('classifies supported scalar values', () => {
    for (const [value, kind] of [
      [null, Kind.NULL],
      [false, Kind.BOOLEAN],
      [true, Kind.BOOLEAN],
      [0, Kind.NUMBER],
      [-0, Kind.NUMBER],
      [-1, Kind.NUMBER],
      [1.5, Kind.NUMBER],
      [1e-7, Kind.NUMBER],
      [2 ** 53 - 1, Kind.NUMBER],
      [0n, Kind.BIGINT],
      [-(2n ** 63n), Kind.BIGINT],
      ['', Kind.STRING],
      ['🙂\n\ud800', Kind.STRING],
      [new Date(0), Kind.DATE],
      [new Uint8Array(), Kind.BYTES],
      [new Uint8Array([0, 255]), Kind.BYTES],
      [Buffer.from([1, 2]), Kind.BYTES],
      [new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999)), Kind.DATE],
      [new Date('0000-01-01T00:00:00.000Z'), Kind.DATE],
    ] as const) {
      assert.strictEqual(classify(value, 'pinot', 3), kind);
    }
  });

  await it('recognises dates and byte arrays from another realm', () => {
    const foreign = runInNewContext(
      '({ date: new Date(0), bytes: new Uint8Array([1, 2]), bad: new Int8Array(1) })',
    ) as { date: unknown; bytes: unknown; bad: unknown };
    assert.strictEqual(foreign.date instanceof Date, false);
    assert.strictEqual(classify(foreign.date, 'pinot', 0), Kind.DATE);
    assert.strictEqual(classify(foreign.bytes, 'pinot', 0), Kind.BYTES);
    assert.throws(() => classify(foreign.bad, 'pinot', 0), SqlDialectError);
  });

  await it('does not trust a spoofed Symbol.toStringTag', () => {
    for (const tag of ['Date', 'Uint8Array']) {
      const fake = { [Symbol.toStringTag]: tag };
      assert.throws(() => classify(fake, 'pinot', 1), SqlDialectError);
    }

    const view = new DataView(new ArrayBuffer(1));
    Object.defineProperty(view, Symbol.toStringTag, { value: 'Uint8Array' });
    assert.throws(() => classify(view, 'pinot', 1), SqlDialectError);
  });

  await it('rejects byte arrays whose buffer was detached', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    assert.throws(
      () => classify(bytes, 'snowflake', 2),
      (error: unknown): boolean =>
        error instanceof SqlDialectError &&
        error.index === 2 &&
        error.reason === 'byte array buffer is detached',
    );
  });

  await it('rejects unsupported values with indexed dialect errors', () => {
    class Example {}
    const rejected: readonly [unknown, string][] = [
      [undefined, 'undefined is not a supported value'],
      [Symbol('value'), 'symbol values are unsupported'],
      [(): void => {}, 'function values are unsupported'],
      [2 ** 53, 'unsafe integer, use bigint'],
      [1e21, 'unsafe integer, use bigint'],
      [-1e300, 'unsafe integer, use bigint'],
      [Number.NaN, 'non-finite number'],
      [Number.POSITIVE_INFINITY, 'non-finite number'],
      [Number.NEGATIVE_INFINITY, 'non-finite number'],
      [new Date(Number.NaN), 'invalid date'],
      [new Date(Date.UTC(10000, 0, 1)), 'date out of range'],
      [new Date(Date.UTC(-1, 0, 1)), 'date out of range'],
      [[], 'arrays are not values; use join()'],
      [[1], 'arrays are not values; use join()'],
      [new Map(), 'Map values are unsupported; use dialect helpers'],
      [new Set(), 'Set values are unsupported; use dialect helpers'],
      [
        Object.create(null) as object,
        'objects are not values; use dialect helpers',
      ],
      [new Example(), 'objects are not values; use dialect helpers'],
      [
        JSON.parse('{"a":1}') as object,
        'objects are not values; use dialect helpers',
      ],
      [new Int8Array(1), 'only Uint8Array byte values are supported'],
      [new ArrayBuffer(1), 'only Uint8Array byte values are supported'],
      [
        new DataView(new ArrayBuffer(1)),
        'only Uint8Array byte values are supported',
      ],
    ];

    for (const [value, reason] of rejected) {
      assert.throws(
        () => classify(value, 'snowflake', 7),
        (error: unknown): boolean => {
          assert.ok(error instanceof SqlDialectError);
          assert.ok(error instanceof TypeError);
          assert.strictEqual(error.name, 'SqlDialectError');
          assert.strictEqual(error.index, 7);
          assert.strictEqual(error.dialect, 'snowflake');
          assert.strictEqual(error.reason, reason);
          return true;
        },
      );
    }
  });
});

void describe('scalar formatting', async () => {
  await it('formats numbers and bigints as decimal strings', () => {
    assert.strictEqual(formatNumber(0), '0');
    assert.strictEqual(formatNumber(-0), '0');
    assert.strictEqual(formatNumber(-1), '-1');
    assert.strictEqual(formatNumber(1.5), '1.5');
    assert.strictEqual(formatNumber(1e-7), '1e-7');
    assert.strictEqual(formatNumber(2 ** 53 - 1), '9007199254740991');
    assert.strictEqual(formatBigint(0n), '0');
    assert.strictEqual(formatBigint(-(2n ** 63n)), '-9223372036854775808');
  });

  await it('formats UTC dates without quotes', () => {
    assert.strictEqual(formatDateUtc(new Date(0)), '1970-01-01 00:00:00.000');
    assert.strictEqual(
      formatDateUtc(new Date('2024-05-06T07:08:09.123Z')),
      '2024-05-06 07:08:09.123',
    );
    assert.strictEqual(
      formatDateUtc(new Date('0000-01-01T00:00:00.000Z')),
      '0000-01-01 00:00:00.000',
    );
  });
});

void describe('string quoting', async () => {
  await it('uses Pinot fast and slow paths', () => {
    assert.strictEqual(quotePinotString('', 0), "''");
    assert.strictEqual(
      quotePinotString('plain \\ "\n🙂\ud800', 0),
      "'plain \\ \"\n🙂\ud800'",
    );
    assert.strictEqual(quotePinotString("'", 2), "''''");
    assert.strictEqual(quotePinotString("a''b'c", 2), "'a''''b''c'");
    assert.strictEqual(quotePinotString('’', 2), "'’'");
    assert.throws(
      () => quotePinotString('x\0y', 4),
      (error: unknown): boolean => {
        assert.ok(error instanceof SqlDialectError);
        assert.strictEqual(error.index, 4);
        assert.strictEqual(error.dialect, 'pinot');
        assert.strictEqual(error.reason, 'NUL is not allowed in strings');
        return true;
      },
    );
  });

  await it('escapes Snowflake quotes, backslashes and NUL in one pass', () => {
    assert.strictEqual(quoteSnowflakeString(''), "''");
    assert.strictEqual(quoteSnowflakeString('clean'), "'clean'");
    assert.strictEqual(
      quoteSnowflakeString('plain "\n🙂\ud800'),
      "'plain \"\n🙂\ud800'",
    );
    assert.strictEqual(quoteSnowflakeString("'"), "''''");
    assert.strictEqual(quoteSnowflakeString('\\'), "'\\\\'");
    assert.strictEqual(quoteSnowflakeString("\\'"), "'\\\\'''");
    assert.strictEqual(quoteSnowflakeString("\\\\'"), "'\\\\\\\\'''");
    assert.strictEqual(quoteSnowflakeString('x\0y'), "'x\\0y'");
    assert.strictEqual(quoteSnowflakeString('\x1a’'), "'\x1a’'");
  });
});

void describe('hex', async () => {
  await it('formats bytes including buffers and non-zero-offset views', () => {
    assert.strictEqual(hex(new Uint8Array()), '');
    assert.strictEqual(hex(new Uint8Array([0, 255])), '00ff');
    assert.strictEqual(hex(Buffer.from([10, 11, 12])), '0a0b0c');
    assert.strictEqual(
      hex(new Uint8Array([9, 1, 2, 8]).subarray(1, 3)),
      '0102',
    );
    assert.strictEqual(
      hex(new Uint8Array([9, 1, 2, 8]).subarray(1, 3)),
      hexFallback(new Uint8Array([1, 2])),
    );
  });

  await it('matches the fallback for deterministic varied byte inputs', () => {
    for (let seed = 1; seed <= 32; seed++) {
      const bytes = new Uint8Array(seed);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (seed * 31 + i * 17) & 255;
      }

      assert.strictEqual(hex(bytes), hexFallback(bytes));
    }
  });
});

void describe('identifier validation', async () => {
  await it('quotes one part without splitting dots and quotes each array part', () => {
    assert.strictEqual(quoteIdentifier('a"b', 'pinot'), '"a""b"');
    assert.strictEqual(
      quoteIdentifier('schema.table', 'snowflake'),
      '"schema.table"',
    );
    assert.strictEqual(quoteIdentifier(['db', 'a"b'], 'pinot'), '"db"."a""b"');
    assert.strictEqual(
      quoteIdentifier(['one', 'two'], 'snowflake', 3),
      '"one"."two"',
    );
  });

  await it('rejects malformed or overlong identifier parts', () => {
    for (const name of [[], [''], ['a\0b'], ['four'], [1]] as unknown[]) {
      assert.throws(
        () =>
          quoteIdentifier(name as string | readonly string[], 'snowflake', 3),
        SqlDialectError,
      );
    }

    assert.throws(() => quoteIdentifier('', 'pinot'), SqlDialectError);
    assert.throws(() => quoteIdentifier('a\0b', 'pinot'), SqlDialectError);
    assert.throws(() => quoteIdentifier('four', 'pinot', 3), SqlDialectError);
    assert.throws(
      () => quoteIdentifier(4 as unknown as string, 'pinot'),
      SqlDialectError,
    );
  });

  await it('validates bare identifiers and returns the original string', () => {
    const pattern = /^[A-Za-z_][A-Za-z0-9_$]*$/;
    assert.strictEqual(
      assertBareIdentifier('table_1', pattern, 'snowflake'),
      'table_1',
    );
    assert.throws(
      () => assertBareIdentifier('1table', pattern, 'snowflake'),
      SqlDialectError,
    );
    assert.throws(
      () => assertBareIdentifier('x.y', pattern, 'pinot'),
      SqlDialectError,
    );
    assert.throws(
      () => assertBareIdentifier(3 as unknown as string, pattern, 'pinot'),
      SqlDialectError,
    );
  });
});

void describe('assertShape', async () => {
  await it('accepts structurally cloned SQL data', () => {
    const cloned = structuredClone(sql`a ${1}`);
    assertShape(cloned, 'pinot');
  });

  await it('rejects invalid structural data', () => {
    const invalid = [
      null,
      undefined,
      1,
      (): void => {},
      {},
      { strings: '', values: [] },
      { strings: ['a'], values: '' },
      { strings: ['a', 'b'], values: [] },
      { strings: ['a', 1], values: [1] },
    ];

    for (const query of invalid) {
      assert.throws(
        () => assertShape(query as never, 'snowflake'),
        SqlDialectError,
      );
    }

    assertShape({ strings: [''], values: [] }, 'pinot');
    assert.throws(
      () => assertShape({ strings: [], values: [] }, 'pinot'),
      SqlDialectError,
    );
    assert.throws(
      () => assertShape({ strings: [1], values: [] } as never, 'pinot'),
      SqlDialectError,
    );

    const missingString = sql`a ${1}`;
    missingString.strings.pop();
    assert.throws(() => assertShape(missingString, 'pinot'), SqlDialectError);

    const extraValue = sql`a`;
    extraValue.values.push(1);
    assert.throws(() => assertShape(extraValue, 'pinot'), SqlDialectError);
  });
});

void describe('token fusion guards', async () => {
  await it('matches the before and after character sets', () => {
    const before = new Set(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$&\'".-',
    );
    const after = new Set(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$\'".',
    );

    for (let code = 0; code < 128; code++) {
      assert.strictEqual(
        needsSpaceBefore(code),
        before.has(String.fromCharCode(code)),
      );
      assert.strictEqual(
        needsSpaceAfter(code),
        after.has(String.fromCharCode(code)),
      );
    }

    for (const code of [32, 40, 44, 41, 42, -1, Number.NaN]) {
      assert.strictEqual(needsSpaceBefore(code), false);
      assert.strictEqual(needsSpaceAfter(code), false);
    }

    // Non-ASCII may be an identifier character (e.g. `é1`): always separate.
    for (const code of [128, 0xe9, 0x2019, 0xd83d]) {
      assert.strictEqual(needsSpaceBefore(code), true);
      assert.strictEqual(needsSpaceAfter(code), true);
    }
  });
});

void describe('hexFallback with an overridden length', async () => {
  await it('uses the intrinsic typed array length', () => {
    class LongBytes extends Uint8Array {
      override get length(): number {
        return 8;
      }
    }

    assert.strictEqual(hexFallback(new LongBytes([1, 2])), '0102');
  });
});
