import * as fc from 'fast-check';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bareIdentifier,
  bind,
  identifier,
  inline,
  type SnowflakeBind,
  type SnowflakeOptions,
  SqlDialectError,
  type SnowflakeStatement,
  variant,
} from '../../src/dialects/snowflake.js';
import sql, { bulk, empty, join, raw, Sql } from '../../src/index.js';
import {
  quotedIdentifiers,
  statementCount,
  stringLiterals,
  summarize,
  tokenizeSnowflake,
} from './tokenizers.js';

function throwsAt(fn: () => unknown, index: number | undefined): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SqlDialectError, String(error));
    assert.strictEqual(error.dialect, 'snowflake');
    assert.strictEqual(error.index, index);
    return true;
  });
}

/** Bind one value after `SELECT `, which is always the only value of the query. */
function one(value: unknown, options?: SnowflakeOptions): SnowflakeBind {
  const { binds } = bind(sql`SELECT ${value}`, options);
  assert.strictEqual(binds.length, 1);
  return binds[0] as SnowflakeBind;
}

function placeholders(text: string): number {
  return text.split('?').length - 1;
}

const DATE = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6));
const DATE_ISO = '2024-01-02T03:04:05.006Z';

// Subclasses whose overridden methods would return SQL text if a renderer called them.
class EvilDate extends Date {
  override toISOString(): string {
    return "x'; DROP TABLE t; --";
  }
  override getTime(): number {
    return NaN;
  }
  override toJSON(): string {
    return 'evil';
  }
}
class EvilBytes extends Uint8Array {
  override get length(): number {
    return 99;
  }
  toHex(): string {
    return "'; DROP TABLE t; --";
  }
}

void describe('snowflake bind scalars', async () => {
  await it('binds null and booleans as-is', () => {
    assert.strictEqual(one(null), null);
    assert.strictEqual(one(true), true);
    assert.strictEqual(one(false), false);
    assert.deepStrictEqual(bind(sql`SELECT ${null}`), {
      sqlText: 'SELECT ?',
      binds: [null],
    });
  });

  await it('binds numbers as-is', () => {
    const cases: number[] = [
      0,
      -1,
      1.5,
      1e-7,
      2 ** 53 - 1,
      -(2 ** 53 - 1),
      Number.MIN_VALUE,
    ];
    for (const value of cases) {
      assert.strictEqual(one(value), value);
    }

    // `==` semantics on purpose: the driver serialises -0 as "0" either way.
    assert.ok(one(-0) === 0);
  });

  await it('rejects unsafe integers, NaN and infinities with the value index', () => {
    for (const value of [2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity]) {
      throwsAt(() => bind(sql`SELECT ${1}, ${value}`), 1);
    }
  });

  await it('binds bigint as decimal digits', () => {
    assert.strictEqual(one(0n), '0');
    assert.strictEqual(one(-(2n ** 63n)), '-9223372036854775808');
    assert.strictEqual(one(2n ** 64n), '18446744073709551616');
  });

  await it('binds strings verbatim, including NUL, quotes and unicode', () => {
    const cases: string[] = [
      '',
      'abc',
      "it's",
      "'",
      'héllo 🙂 日本',
      'a\nb\r\nc',
      'back\\slash',
      'a"b',
      'a\0b',
      '\0',
      '\x1a',
      '\ud800',
    ];
    for (const value of cases) {
      assert.strictEqual(one(value), value);
    }
  });

  await it('binds dates as ISO-8601 UTC strings', () => {
    assert.strictEqual(one(DATE), DATE_ISO);
    assert.strictEqual(one(new Date(0)), '1970-01-01T00:00:00.000Z');
  });

  await it('rejects invalid and out-of-range dates', () => {
    throwsAt(() => bind(sql`SELECT ${new Date(NaN)}`), 0);
    throwsAt(() => bind(sql`SELECT ${1}, ${new Date(8.64e15)}`), 1);
  });

  await it('binds bytes as hex behind TO_BINARY', () => {
    const cases: [Uint8Array, string][] = [
      [new Uint8Array([]), ''],
      [new Uint8Array([0, 255]), '00ff'],
      [Buffer.from([1, 2, 171]), '0102ab'],
    ];
    for (const [bytes, hex] of cases) {
      assert.deepStrictEqual(bind(sql`SELECT ${bytes}`), {
        sqlText: "SELECT TO_BINARY(?, 'HEX')",
        binds: [hex],
      });
    }
  });

  await it('keeps the bind array flat when the first value is a Date, bigint or bytes', () => {
    const first: [unknown, SnowflakeBind][] = [
      [DATE, DATE_ISO],
      [7n, '7'],
      [new Uint8Array([1]), '01'],
    ];
    for (const [value, expected] of first) {
      const { sqlText, binds } = bind(sql`SELECT ${value}, ${1}`);
      assert.ok(!Array.isArray(binds[0]));
      assert.strictEqual(binds[0], expected);
      assert.strictEqual(binds[1], 1);
      assert.strictEqual(placeholders(sqlText), 2);
    }
  });

  await it('ignores Date and Uint8Array subclasses that override methods', () => {
    assert.strictEqual(one(new EvilDate(DATE.getTime())), DATE_ISO);
    assert.strictEqual(one(new EvilBytes([1, 2])), '0102');
  });
});

class Custom {
  readonly a = 1;
}

const REJECTED: [string, unknown][] = [
  ['undefined', undefined],
  ['symbol', Symbol('x')],
  ['function', () => 1],
  ['object', {}],
  ['empty array', []],
  ['array', [1]],
  ['Map', new Map()],
  ['Set', new Set()],
  ['null-prototype object', Object.create(null)],
  ['class instance', new Custom()],
  ['parsed JSON', JSON.parse('{"a":1}') as unknown],
  ['Uint16Array', new Uint16Array(1)],
  ['ArrayBuffer', new ArrayBuffer(1)],
];

const LUXON = { toISO: (): string => DATE_ISO };
const toIso = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'toISO' in value
    ? (value as typeof LUXON).toISO()
    : value;

void describe('snowflake bind rejections', async () => {
  await it('throws SqlDialectError with the value index', () => {
    for (const [name, value] of REJECTED) {
      assert.throws(
        () => bind(sql`SELECT ${1}, ${2}, ${value}`),
        (error: unknown) => {
          assert.ok(error instanceof SqlDialectError, name);
          assert.strictEqual(error.index, 2, name);
          return true;
        },
        name,
      );
    }
  });

  await it('rejects a first value that would trigger driver array-binding', () => {
    throwsAt(() => bind(sql`SELECT ${[1, 2]}`), 0);
    throwsAt(() => bind(sql`SELECT ${[[1]]}, ${1}`), 0);
  });

  await it('reports the flattened index of values in nested fragments', () => {
    throwsAt(() => bind(sql`SELECT ${join([1, undefined])}`), 1);
  });
});

void describe('snowflake bind coerce', async () => {
  const luxon = LUXON;
  const coerce = toIso;

  await it('maps custom objects to supported binds', () => {
    assert.deepStrictEqual(
      bind(sql`SELECT ${luxon}, ${1}, ${'a'}`, { coerce }),
      {
        sqlText: 'SELECT ?, ?, ?',
        binds: [DATE_ISO, 1, 'a'],
      },
    );
  });

  await it('can map undefined to NULL and plain values to Dates and bytes', () => {
    assert.strictEqual(
      one(undefined, { coerce: (v) => (v === undefined ? null : v) }),
      null,
    );
    assert.strictEqual(one(1, { coerce: () => DATE }), DATE_ISO);
    assert.deepStrictEqual(
      bind(sql`SELECT ${1}`, { coerce: () => new Uint8Array([255]) }),
      { sqlText: "SELECT TO_BINARY(?, 'HEX')", binds: ['ff'] },
    );
  });

  await it('cannot smuggle raw SQL: the result is bound like any string', () => {
    assert.deepStrictEqual(
      bind(sql`SELECT ${1}`, { coerce: () => "x' OR 1=1 --" }),
      {
        sqlText: 'SELECT ?',
        binds: ["x' OR 1=1 --"],
      },
    );
  });

  await it('rejects a coerce result that is not a supported value', () => {
    const results: unknown[] = [{}, [], undefined, sql`SELECT 1`, () => 1];
    for (const result of results) {
      throwsAt(() => bind(sql`SELECT ${1}, ${2}`, { coerce: () => result }), 0);
    }
  });

  await it('rejects invalid options', () => {
    const bad: unknown[] = [
      { coerce: 'x' },
      { coerce: null },
      null,
      42,
      'string',
    ];
    for (const options of bad) {
      throwsAt(() => bind(sql`SELECT ${1}`, options as never), undefined);
    }
  });

  await it('accepts empty options', () => {
    assert.deepStrictEqual(bind(sql`SELECT ${1}`, {}), {
      sqlText: 'SELECT ?',
      binds: [1],
    });
  });
});

void describe('snowflake bind text', async () => {
  await it('only ever emits ? placeholders, one bind per placeholder', () => {
    const query = sql`SELECT ${1}, ${'a'}, ${new Uint8Array([1])}, ${DATE}, ${null}, ${2n} WHERE x IN (${join([true, 'b'])})`;
    const { sqlText, binds } = bind(query);
    assert.ok(!/\$\d|:\d/.test(sqlText), sqlText);
    assert.strictEqual(placeholders(sqlText), binds.length);
    assert.strictEqual(binds.length, 8);
    assert.strictEqual(
      sqlText,
      "SELECT ?, ?, TO_BINARY(?, 'HEX'), ?, ?, ? WHERE x IN (?,?)",
    );
  });

  await it('does not use core $n or :n text even for hostile-looking template text', () => {
    const { sqlText } = bind(sql`SELECT a$1, b:c, ${1}`);
    assert.strictEqual(sqlText, 'SELECT a$1, b:c, ?');
  });

  await it('keeps template text byte for byte, with no fusion spacing', () => {
    assert.strictEqual(bind(sql`a-${-1}`).sqlText, 'a-?');
    assert.strictEqual(bind(sql`${'a'}${'b'}`).sqlText, '??');
    assert.strictEqual(bind(sql`${1}`).sqlText, '?');
    assert.strictEqual(bind(sql`X${'41'}`).sqlText, 'X?');
  });

  await it('rejects a bare ? in template text without an index', () => {
    const queries: Sql[] = [
      sql`SELECT ?`,
      sql`SELECT ${1} WHERE a = ?`,
      sql`SELECT ${raw('?')}`,
      sql`SELECT ${1}, ${raw('??')}`,
    ];
    for (const query of queries) {
      throwsAt(() => bind(query), undefined);
    }
  });

  await it('allows ? inside strings, identifiers and comments', () => {
    assert.strictEqual(bind(sql`SELECT '?', ${1}`).sqlText, "SELECT '?', ?");
    assert.strictEqual(bind(sql`SELECT "?", ${1}`).sqlText, 'SELECT "?", ?');
    assert.strictEqual(
      bind(sql`SELECT ${1} -- ?\n`).sqlText,
      'SELECT ? -- ?\n',
    );
    assert.strictEqual(
      bind(sql`SELECT ${1} // ?\n`).sqlText,
      'SELECT ? // ?\n',
    );
    assert.strictEqual(
      bind(sql`SELECT ${1} /* ? */`).sqlText,
      'SELECT ? /* ? */',
    );
    assert.strictEqual(
      bind(sql`SELECT $$?$$, ${1}`).sqlText,
      'SELECT $$?$$, ?',
    );
    assert.strictEqual(bind(sql`SELECT ${1} -- ?`).sqlText, 'SELECT ? -- ?');
  });

  await it('rejects values inside quotes and comments', () => {
    const queries: Sql[] = [
      sql`SELECT '${'v'}'`,
      sql`SELECT 'it''s ${'v'}'`,
      sql`SELECT "${'v'}"`,
      sql`SELECT \`${'v'}\``,
      sql`SELECT $$ ${'v'} $$`,
      sql`SELECT 1 -- ${'v'}\n`,
      sql`SELECT 1 // ${'v'}\n`,
      sql`SELECT 1 /* ${'v'} */`,
      sql`SELECT 'a${'v'}b${1}c'`,
    ];
    for (const query of queries) {
      throwsAt(() => bind(query), 0);
    }
  });

  await it('treats a backslash as an escape inside strings', () => {
    throwsAt(() => bind(sql`SELECT 'it\\'s ${'v'}'`), 0);
    throwsAt(() => bind(sql`SELECT '\\'${'v'}`), 0);
    assert.strictEqual(
      bind(sql`SELECT '\\\\', ${'v'}`).sqlText,
      "SELECT '\\\\', ?",
    );
  });

  await it('rejects raw quote wrapping and unterminated contexts', () => {
    throwsAt(() => bind(sql`${raw("'")}${'v'}${raw("'")}`), 0);
    throwsAt(() => bind(sql`${raw('$$')}${'v'}${raw('$$')}`), 0);
    throwsAt(() => bind(sql`SELECT 'abc`), undefined);
    throwsAt(() => bind(sql`SELECT ${1} /* abc`), undefined);
  });
});

const CORPUS: readonly string[] = [
  "'",
  "x' OR 1=1 --",
  "'; SELECT 2; /*",
  "\\'; --",
  "\\\\'",
  'back\\slash',
  'a"b',
  '/* ? */ -- ?',
  '// x',
  '$$',
  '$$; DROP TABLE t; $$',
  '? ?? :1 $1',
  '\0',
  '\x1a',
  '’',
  '\ud800',
  '',
  '\n--\n',
  '-- x',
  '/*',
  '*/',
];

interface Context {
  readonly name: string;
  readonly build: (value: string) => Sql;
  /** The exact `sqlText` expected for the template, whatever the value. */
  readonly sqlText: string;
  readonly binds: (value: string) => SnowflakeBind[];
}

const CONTEXTS: readonly Context[] = [
  {
    name: 'sql',
    build: (s) => sql`SELECT ${s}`,
    sqlText: 'SELECT ?',
    binds: (s) => [s],
  },
  {
    name: 'join',
    build: (s) => sql`SELECT 1 WHERE a IN (${join([s, 'x', s])})`,
    sqlText: 'SELECT 1 WHERE a IN (?,?,?)',
    binds: (s) => [s, 'x', s],
  },
  {
    name: 'bulk',
    build: (s) =>
      sql`INSERT INTO t VALUES ${bulk([
        [s, 1],
        ['y', s],
      ])}`,
    sqlText: 'INSERT INTO t VALUES (?,?),(?,?)',
    binds: (s) => [s, 1, 'y', s],
  },
  {
    name: 'variant',
    build: (s) => sql`CALL p(${variant({ k: s, list: [s] })})`,
    sqlText: 'CALL p(PARSE_JSON(?))',
    binds: (s) => [JSON.stringify({ k: s, list: [s] })],
  },
];

void describe('snowflake injection corpus', async () => {
  for (const { name, build, sqlText, binds } of CONTEXTS) {
    await it(`binds every value verbatim and keeps it out of sqlText (${name})`, () => {
      for (const value of CORPUS) {
        const statement = bind(build(value));
        const label = JSON.stringify(value);
        assert.strictEqual(statement.sqlText, sqlText, label);
        assert.deepStrictEqual(statement.binds, binds(value), label);
        assert.strictEqual(
          placeholders(statement.sqlText),
          statement.binds.length,
        );
      }
    });
  }

  await it('keeps hostile identifiers inside one quoted identifier', () => {
    for (const value of CORPUS) {
      if (value === '' || value.includes('\0')) {
        continue;
      }

      const { sqlText } = bind(sql`SELECT ${identifier(value)} FROM t`);
      assert.ok(sqlText.startsWith('SELECT "') && sqlText.endsWith('" FROM t'));
      const body = sqlText.slice('SELECT "'.length, -'" FROM t'.length);
      // Every quote is doubled, so none can end the identifier early.
      assert.ok(!body.replaceAll('""', '').includes('"'), body);
      assert.strictEqual(body.replaceAll('""', '"'), value);
    }
  });
});

// Biased towards the characters that matter to the lexer, plus lone surrogates.
const hostileChar = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      "'",
      '\\',
      '"',
      '-',
      '/',
      '*',
      '\n',
      ' ',
      ';',
      '?',
      '$',
      '\0',
      'é',
      '🙂',
      '\ud800',
      '\udc00',
    ),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 1 }) },
);
const hostileString = fc.string({ unit: hostileChar, maxLength: 40 });

void describe('snowflake bind properties', async () => {
  await it('binds any string verbatim behind a single placeholder', () => {
    fc.assert(
      fc.property(hostileString, hostileString, (a, b) => {
        const statement = bind(sql`SELECT x=${a}AND y=${b}--tail`);
        assert.strictEqual(statement.sqlText, 'SELECT x=?AND y=?--tail');
        assert.deepStrictEqual(statement.binds, [a, b]);
      }),
      { numRuns: 500 },
    );
  });

  await it('binds finite numbers unchanged', () => {
    fc.assert(
      fc.property(
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n) || Number.isSafeInteger(n)),
        (n) => {
          assert.ok(one(n) === n);
        },
      ),
      { numRuns: 500 },
    );
  });

  await it('binds bytes as hex that decodes back to the input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const hex = one(bytes) as string;
        assert.ok(/^(?:[0-9a-f]{2})*$/.test(hex));
        assert.deepStrictEqual(Uint8Array.from(Buffer.from(hex, 'hex')), bytes);
      }),
      { numRuns: 200 },
    );
  });
});

void describe('snowflake variant', async () => {
  await it('returns a plain core Sql with one bound JSON string', () => {
    const v = variant({ a: 1 });
    assert.ok(v instanceof Sql);
    assert.strictEqual(v.sql, 'PARSE_JSON(?)');
    assert.deepStrictEqual(v.values, ['{"a":1}']);
  });

  await it('serialises nested objects, arrays and scalars', () => {
    const cases: unknown[] = [
      { a: { b: [1, 2, { c: null }] }, d: [] },
      [1, 'two', [3]],
      'it\'s "quoted" \\ \n',
      42,
      true,
      null,
      '',
      DATE,
    ];
    for (const value of cases) {
      assert.deepStrictEqual(variant(value).values, [JSON.stringify(value)]);
    }
  });

  await it('honours toJSON', () => {
    const value = {
      toJSON: (): unknown => ({ z: 1 }),
    };
    assert.deepStrictEqual(variant(value).values, ['{"z":1}']);
  });

  await it('rethrows serialisation failures as SqlDialectError with a cause', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const value of [{ a: 1n }, [2n], cyclic]) {
      assert.throws(
        () => variant(value),
        (error: unknown) => {
          assert.ok(error instanceof SqlDialectError);
          assert.strictEqual(error.dialect, 'snowflake');
          assert.strictEqual(error.index, undefined);
          assert.ok(error.reason.startsWith('variant(): '), error.reason);
          assert.ok(error.cause instanceof TypeError);
          return true;
        },
      );
    }

    assert.throws(
      () =>
        variant({
          toJSON: (): never => {
            throw 'boom';
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SqlDialectError);
        assert.strictEqual(error.cause, 'boom');
        return true;
      },
    );
  });

  await it('rejects values without a JSON representation', () => {
    for (const value of [undefined, () => 1, Symbol('x')]) {
      throwsAt(() => variant(value), undefined);
    }
  });

  await it('composes in a CALL and binds like any other value', () => {
    const statement = bind(sql`CALL p(${variant({ a: ["it's"] })}, ${1})`);
    assert.deepStrictEqual(statement, {
      sqlText: 'CALL p(PARSE_JSON(?), ?)',
      binds: ['{"a":["it\'s"]}', 1],
    });
  });
});

void describe('snowflake identifiers', async () => {
  await it('return plain core Sql instances', () => {
    assert.ok(identifier('a') instanceof Sql);
    assert.ok(identifier(['a', 'b']) instanceof Sql);
    assert.ok(bareIdentifier('a') instanceof Sql);
  });

  await it('identifier quotes, keeps case and never splits on dots', () => {
    assert.strictEqual(identifier('a').sql, '"a"');
    assert.strictEqual(identifier('MyTable').sql, '"MyTable"');
    assert.strictEqual(identifier('a.b').sql, '"a.b"');
    assert.strictEqual(identifier('a"b').sql, '"a""b"');
    assert.strictEqual(identifier('select').sql, '"select"');
    assert.strictEqual(identifier(['db', 'S', 't']).sql, '"db"."S"."t"');
    assert.strictEqual(identifier(['a.b', 'c"d']).sql, '"a.b"."c""d"');
  });

  await it('identifier allows 255 characters per part and rejects 256', () => {
    const ok = 'a'.repeat(255);
    assert.strictEqual(identifier(ok).sql, `"${ok}"`);
    assert.strictEqual(identifier([ok, ok]).sql, `"${ok}"."${ok}"`);
    throwsAt(() => identifier('a'.repeat(256)), undefined);
    throwsAt(() => identifier(['a', 'a'.repeat(256)]), undefined);
  });

  await it('identifier rejects invalid names', () => {
    const bad: unknown[] = ['', 'a\0', [], [''], ['a', ''], ['a', 1], 1, null];
    for (const name of bad) {
      throwsAt(() => identifier(name as never), undefined);
    }
  });

  await it('bareIdentifier validates and emits verbatim', () => {
    for (const name of ['abc_1', '_x', 'A$', 'a$b$', '_$', 'x'.repeat(255)]) {
      assert.strictEqual(bareIdentifier(name).sql, name);
    }

    const bad = [
      '',
      '1a',
      '$a',
      'a-b',
      'a b',
      'a.b',
      'é',
      'a\n',
      'a"',
      "a'",
      'a;',
      'x'.repeat(256),
    ];
    for (const name of bad) {
      throwsAt(() => bareIdentifier(name), undefined);
    }

    throwsAt(() => bareIdentifier(1 as never), undefined);
  });

  await it('bareIdentifier parts join into a dotted path', () => {
    const path = join(['db', 'schema', 'tbl'].map(bareIdentifier), '.');
    assert.strictEqual(
      bind(sql`SELECT * FROM ${path}`).sqlText,
      'SELECT * FROM db.schema.tbl',
    );
  });
});

void describe('snowflake structural checks', async () => {
  await it('never mutates the input', () => {
    const query = sql`SELECT ${DATE}, ${1n}, ${new Uint8Array([1])} -- tail`;
    const strings = [...query.strings];
    const values = [...query.values];
    bind(query);
    assert.deepStrictEqual(query.strings, strings);
    assert.deepStrictEqual(query.values, values);
  });

  await it('rejects queries whose strings and values disagree', () => {
    const extraValue = sql`SELECT ${1}`;
    extraValue.values.push(2);
    throwsAt(() => bind(extraValue), undefined);

    const missingString = sql`SELECT ${1}`;
    missingString.strings.pop();
    throwsAt(() => bind(missingString), undefined);

    const badString = sql`SELECT ${1}`;
    badString.strings[1] = 1 as never;
    throwsAt(() => bind(badString), undefined);
  });

  await it('rejects non-query inputs', () => {
    for (const query of [
      null,
      undefined,
      'SELECT 1',
      42,
      {},
      { strings: 'a', values: [] },
    ]) {
      throwsAt(() => bind(query as never), undefined);
    }
  });

  await it('accepts structurally cloned queries and is deterministic', () => {
    const query = sql`SELECT ${'a'}, ${DATE}`;
    const clone = structuredClone<Sql>(query);
    assert.deepStrictEqual(bind(clone), bind(query));
    assert.deepStrictEqual(bind(query), bind(query));
  });

  await it('leaves core getters untouched on helper fragments', () => {
    const fragment = sql`SELECT ${identifier('a')} FROM t WHERE b = ${1} AND c = ${variant({ k: 1 })}`;
    assert.deepStrictEqual(fragment.inspect(), {
      sql: 'SELECT "a" FROM t WHERE b = ? AND c = PARSE_JSON(?)',
      statement: 'SELECT "a" FROM t WHERE b = :1 AND c = PARSE_JSON(:2)',
      text: 'SELECT "a" FROM t WHERE b = $1 AND c = PARSE_JSON($2)',
      values: [1, '{"k":1}'],
    });
  });

  await it('composes with sql, join, bulk, raw and empty', () => {
    const query = sql`SELECT ${join([identifier('a'), bareIdentifier('b')])} FROM ${identifier(['s', 't'])} WHERE d IN ${bulk([[1, identifier('x')]])}${empty}${raw('')}`;
    assert.deepStrictEqual(bind(query), {
      sqlText: 'SELECT "a",b FROM "s"."t" WHERE d IN (?,"x")',
      binds: [1],
    });
  });
});

/** Render one value after `SELECT `, so no fusion guard is involved. */
function lit(value: unknown, options?: SnowflakeOptions): string {
  return inline(sql`SELECT ${value}`, options).slice('SELECT '.length);
}

void describe('snowflake inline scalars', async () => {
  await it('renders null and booleans', () => {
    assert.strictEqual(lit(null), 'NULL');
    assert.strictEqual(lit(true), 'TRUE');
    assert.strictEqual(lit(false), 'FALSE');
  });

  await it('renders numbers', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [-0, '0'],
      [-1, '-1'],
      [1.5, '1.5'],
      [1e-7, '1e-7'],
      [2 ** 53 - 1, '9007199254740991'],
      [-(2 ** 53 - 1), '-9007199254740991'],
    ];
    for (const [value, expected] of cases) {
      assert.strictEqual(lit(value), expected);
    }
  });

  await it('rejects unsafe integers, NaN and infinities with the value index', () => {
    for (const value of [2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity]) {
      throwsAt(() => inline(sql`SELECT ${1}, ${value}`), 1);
    }
  });

  await it('renders bigint as digits', () => {
    assert.strictEqual(lit(0n), '0');
    assert.strictEqual(lit(-(2n ** 63n)), '-9223372036854775808');
    assert.strictEqual(lit(2n ** 64n), '18446744073709551616');
  });

  await it('escapes backslashes, quotes and NUL in strings', () => {
    const cases: [string, string][] = [
      ['', "''"],
      ['abc', "'abc'"],
      ["it's", "'it''s'"],
      ["'", "''''"],
      ['héllo 🙂 日本', "'héllo 🙂 日本'"],
      ['a\nb\r\nc', "'a\nb\r\nc'"],
      ['back\\slash', "'back\\\\slash'"],
      ['\\', "'\\\\'"],
      ["\\'", "'\\\\'''"],
      ["\\\\'", "'\\\\\\\\'''"],
      ['a"b', "'a\"b'"],
      ['\0', "'\\0'"],
      ['a\0b', "'a\\0b'"],
      ['\x1a', "'\x1a'"],
      ['$$', "'$$'"],
      ['\ud800', "'\ud800'"],
    ];
    for (const [value, expected] of cases) {
      assert.strictEqual(lit(value), expected);
    }
  });

  await it('renders dates as ISO-8601 UTC strings', () => {
    assert.strictEqual(lit(DATE), `'${DATE_ISO}'`);
    assert.strictEqual(lit(new Date(0)), "'1970-01-01T00:00:00.000Z'");
  });

  await it('rejects invalid and out-of-range dates', () => {
    throwsAt(() => inline(sql`SELECT ${new Date(NaN)}`), 0);
    throwsAt(() => inline(sql`SELECT ${1}, ${new Date(8.64e15)}`), 1);
  });

  await it('renders bytes as TO_BINARY hex literals', () => {
    assert.strictEqual(lit(new Uint8Array([])), "TO_BINARY('', 'HEX')");
    assert.strictEqual(
      lit(new Uint8Array([0, 255])),
      "TO_BINARY('00ff', 'HEX')",
    );
    assert.strictEqual(
      lit(Buffer.from([1, 2, 171])),
      "TO_BINARY('0102ab', 'HEX')",
    );
  });

  await it('ignores Date and Uint8Array subclasses that override methods', () => {
    assert.strictEqual(lit(new EvilDate(DATE.getTime())), `'${DATE_ISO}'`);
    assert.strictEqual(lit(new EvilBytes([1, 2])), "TO_BINARY('0102', 'HEX')");
  });

  await it('rejects unsupported values with the value index', () => {
    for (const [name, value] of REJECTED) {
      assert.throws(
        () => inline(sql`SELECT ${1}, ${2}, ${value}`),
        (error: unknown) => {
          assert.ok(error instanceof SqlDialectError, name);
          assert.strictEqual(error.index, 2, name);
          return true;
        },
        name,
      );
    }

    throwsAt(() => inline(sql`SELECT ${join([1, undefined])}`), 1);
  });
});

void describe('snowflake inline coerce', async () => {
  await it('maps custom objects to supported literals', () => {
    assert.strictEqual(
      inline(sql`SELECT ${LUXON}, ${1}, ${'a'}`, { coerce: toIso }),
      `SELECT '${DATE_ISO}', 1, 'a'`,
    );
  });

  await it('can map undefined to NULL', () => {
    assert.strictEqual(
      lit(undefined, { coerce: (v) => (v === undefined ? null : v) }),
      'NULL',
    );
  });

  await it('cannot smuggle raw SQL: the result is quoted like any string', () => {
    assert.strictEqual(
      lit(1, { coerce: () => "x' OR 1=1 --" }),
      "'x'' OR 1=1 --'",
    );
    assert.strictEqual(lit(1, { coerce: () => "\\'; --" }), "'\\\\''; --'");
  });

  await it('rejects a coerce result that is not a supported value', () => {
    const results: unknown[] = [{}, [], undefined, sql`SELECT 1`, () => 1];
    for (const result of results) {
      throwsAt(
        () => inline(sql`SELECT ${1}, ${2}`, { coerce: () => result }),
        0,
      );
    }
  });

  await it('rejects invalid options and accepts empty ones', () => {
    const bad: unknown[] = [{ coerce: 'x' }, { coerce: null }, null, 42, 'a'];
    for (const options of bad) {
      throwsAt(() => inline(sql`SELECT ${1}`, options as never), undefined);
    }

    assert.strictEqual(inline(sql`SELECT ${1}`, {}), 'SELECT 1');
  });
});

interface InlineContext {
  readonly name: string;
  readonly build: (value: string) => Sql;
  /** The string literals the rendered text must decode to. */
  readonly literals: (value: string) => string[];
}

const INLINE_CONTEXTS: readonly InlineContext[] = [
  {
    name: 'sql',
    build: (s) => sql`SELECT ${s}`,
    literals: (s) => [s],
  },
  {
    name: 'join',
    build: (s) => sql`SELECT 1 WHERE a IN (${join([s, 'x', s])})`,
    literals: (s) => [s, 'x', s],
  },
  {
    name: 'bulk',
    build: (s) =>
      sql`INSERT INTO t VALUES ${bulk([
        [s, 1],
        ['y', s],
      ])}`,
    literals: (s) => [s, 'y', s],
  },
  {
    name: 'variant',
    build: (s) => sql`CALL p(${variant({ k: s, list: [s] })})`,
    literals: (s) => [JSON.stringify({ k: s, list: [s] })],
  },
];

function assertInert(text: string, literals: string[], label: string): void {
  const tokens = tokenizeSnowflake(text);
  assert.deepStrictEqual(stringLiterals(tokens), literals, label);
  assert.ok(
    tokens.every((t) => t.kind !== 'comment' && t.kind !== 'unterminated'),
    label,
  );
  assert.strictEqual(statementCount(tokens), 1, label);
}

void describe('snowflake inline injection corpus', async () => {
  for (const { name, build, literals } of INLINE_CONTEXTS) {
    await it(`decodes every value back to string literals (${name})`, () => {
      for (const value of CORPUS) {
        const text = inline(build(value));
        const label = `${JSON.stringify(value)} -> ${JSON.stringify(text)}`;
        assertInert(text, literals(value), label);
      }
    });
  }

  await it('decodes hostile identifiers back to one quoted identifier', () => {
    for (const value of CORPUS) {
      if (value === '' || value.includes('\0')) {
        continue;
      }

      const text = inline(sql`SELECT ${identifier(value)} FROM t`);
      const tokens = tokenizeSnowflake(text);
      assert.deepStrictEqual(quotedIdentifiers(tokens), [value], text);
      assert.strictEqual(statementCount(tokens), 1, text);
      assert.ok(
        tokens.every((t) => t.kind !== 'comment'),
        text,
      );
    }
  });

  await it('keeps the classic backslash breakout inert', () => {
    assert.strictEqual(
      lit("\\'; DROP TABLE t; --"),
      "'\\\\''; DROP TABLE t; --'",
    );
    assert.strictEqual(lit("\\\\'"), "'\\\\\\\\'''");
    assert.strictEqual(lit('$$; DROP TABLE t; $$'), "'$$; DROP TABLE t; $$'");
  });

  await it('renders a variant payload as one escaped string argument', () => {
    const payload = { a: ["it's", 'back\\slash'] };
    assert.strictEqual(
      inline(sql`CALL p(${variant(payload)})`),
      'CALL p(PARSE_JSON(\'{"a":["it\'\'s","back\\\\\\\\slash"]}\'))',
    );
  });
});

// Whole-token chunks (escape sequences, comment and dollar-quote openers) on top of the
// single characters of `hostileChar`, so every interesting adjacency appears often.
const hostileChunk = fc.constantFrom(
  "\\'",
  "\\\\'",
  "'\\",
  '\\\\',
  '$$',
  '//',
  '--',
  '/*',
  '*/',
  "'",
  '\\',
  '\0',
  '\n',
  '\\0',
  'é',
  '🙂',
  '\ud800',
  '\udc00',
);
const hostileText = fc.oneof(
  hostileString,
  fc.array(hostileChunk, { maxLength: 12 }).map((chunks) => chunks.join('')),
);

void describe('snowflake inline round-trip properties', async () => {
  await it('decodes an inlined string back to the input', () => {
    fc.assert(
      fc.property(hostileText, (s) => {
        const tokens = tokenizeSnowflake(inline(sql`SELECT ${s}`));
        assert.deepStrictEqual(stringLiterals(tokens), [s]);
        assert.ok(tokens.every((t) => t.kind !== 'comment'));
        assert.strictEqual(statementCount(tokens), 1);
      }),
      { numRuns: 2000 },
    );
  });

  await it('adds no statements or comments around two values and a trailing comment', () => {
    fc.assert(
      fc.property(hostileText, hostileText, (a, b) => {
        const text = inline(sql`SELECT ${a}, ${b} // c`);
        const tokens = tokenizeSnowflake(text);
        assert.deepStrictEqual(stringLiterals(tokens), [a, b], text);
        assert.strictEqual(statementCount(tokens), 1, text);
        assert.strictEqual(
          tokens.filter((t) => t.kind === 'comment').length,
          1,
        );
        assert.ok(
          tokens.every((t) => t.kind !== 'unterminated'),
          text,
        );
      }),
      { numRuns: 1000 },
    );
  });

  await it('decodes strings between template text without fusion', () => {
    fc.assert(
      fc.property(hostileText, hostileText, (a, b) => {
        const text = inline(sql`SELECT x=${a}AND y=${b}--tail`);
        const tokens = tokenizeSnowflake(text);
        assert.deepStrictEqual(stringLiterals(tokens), [a, b]);
        assert.strictEqual(
          tokens.filter((t) => t.kind === 'comment').length,
          1,
        );
      }),
      { numRuns: 500 },
    );
  });

  await it('decodes hostile identifiers back to the input', () => {
    fc.assert(
      fc.property(
        hostileText.filter((s) => s !== '' && !s.includes('\0')),
        (s) => {
          const tokens = tokenizeSnowflake(
            inline(sql`SELECT ${identifier(s)}`),
          );
          assert.deepStrictEqual(quotedIdentifiers(tokens), [s]);
          assert.ok(tokens.every((t) => t.kind !== 'comment'));
        },
      ),
      { numRuns: 500 },
    );
  });

  await it('renders finite numbers parseable back to the input', () => {
    fc.assert(
      fc.property(
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n) || Number.isSafeInteger(n)),
        (n) => {
          // `==` semantics on purpose: -0 renders as `0`.
          assert.ok(Number(lit(n)) === n, lit(n));
        },
      ),
      { numRuns: 500 },
    );
  });

  await it('renders bytes as hex that decodes back to the input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const text = lit(bytes);
        const match = /^TO_BINARY\('((?:[0-9a-f]{2})*)', 'HEX'\)$/.exec(text);
        assert.ok(match !== null, text);
        assert.deepStrictEqual(
          Uint8Array.from(Buffer.from(match[1] as string, 'hex')),
          bytes,
        );
      }),
      { numRuns: 200 },
    );
  });
});

const tokens = (query: Sql): string[] =>
  summarize(inline(query), tokenizeSnowflake);

void describe('snowflake inline token fusion', async () => {
  await it('keeps adjacent literals and text apart', () => {
    const cases: [Sql, string[]][] = [
      [sql`a-${-1}`, ['a', '-', '-', '1']],
      [sql`${"a'"}${"b'"}`, ["str(a')", "str(b')"]],
      [sql`X${'41'}`, ['X', 'str(41)']],
      [sql`$${1}`, ['$', '1']],
      [sql`t.${5}`, ['t', '.', '5']],
      [sql`${1}e5`, ['1', 'e5']],
      [sql`${true}$$x$$`, ['TRUE', 'str(x)']],
      [sql`${'a'}'b'`, ['str(a)', 'str(b)']],
      [sql`${1}x`, ['1', 'x']],
      [sql`a.${'b'}`, ['a', '.', 'str(b)']],
      [sql`${'a'}$$b$$`, ['str(a)', 'str(b)']],
    ];
    for (const [query, expected] of cases) {
      assert.deepStrictEqual(tokens(query), expected, inline(query));
    }
  });

  await it('does not turn a negative number after a minus or slash into a comment', () => {
    assert.ok(!inline(sql`a-${-1}`).includes('--'));
    assert.ok(!inline(sql`a/${'x'}`).includes('//'));
    assert.deepStrictEqual(tokens(sql`a/${'x'}`), ['a', '/', 'str(x)']);
  });

  await it('does not fuse non-ASCII neighbours', () => {
    assert.deepStrictEqual(tokens(sql`é${1}`), ['é', '1']);
    assert.deepStrictEqual(tokens(sql`${1}é`), ['1', 'é']);
  });

  await it('passes other text through byte for byte', () => {
    assert.strictEqual(inline(sql`(${1},${2})`), '(1,2)');
    assert.strictEqual(inline(sql`a = ${1} AND b<${'x'}`), "a = 1 AND b<'x'");
    assert.strictEqual(inline(sql`${1} + 1`), '1 + 1');
    assert.strictEqual(inline(sql`${1}`), '1');
    assert.strictEqual(inline(sql`SELECT ${1} -- tail`), 'SELECT 1 -- tail');
    assert.strictEqual(inline(sql`SELECT ${1} // tail`), 'SELECT 1 // tail');
  });

  await it('keeps a literal that ends a chunk from fusing with the next literal', () => {
    assert.strictEqual(inline(sql`${'a'}${'b'}`), "'a' 'b'");
    assert.strictEqual(inline(sql`${1}${2}`), '1 2');
    assert.strictEqual(inline(sql`${1},${2}`), '1,2');
  });
});

void describe('snowflake inline text and context guard', async () => {
  await it('renders multi-statement requests', () => {
    const text = inline(sql`SET x = ${1}; SELECT ${'a'};`);
    assert.strictEqual(text, "SET x = 1; SELECT 'a';");
    assert.strictEqual(statementCount(tokenizeSnowflake(text)), 2);
  });

  await it('keeps a bare ? in template text, unlike bind', () => {
    assert.strictEqual(inline(sql`SELECT ? , ${1}`), 'SELECT ? , 1');
    assert.strictEqual(inline(sql`SELECT ${raw('?')}, ${1}`), 'SELECT ?, 1');
    throwsAt(() => bind(sql`SELECT ? , ${1}`), undefined);
  });

  await it('rejects values inside quotes and comments', () => {
    const queries: Sql[] = [
      sql`SELECT '${'v'}'`,
      sql`SELECT 'it''s ${'v'}'`,
      sql`SELECT 'it\\'s ${'v'}'`,
      sql`SELECT "${'v'}"`,
      sql`SELECT $$ ${'v'} $$`,
      sql`SELECT 1 -- ${'v'}\n`,
      sql`SELECT 1 // ${'v'}\n`,
      sql`SELECT 1 /* ${'v'} */`,
      sql`SELECT 'a${'v'}b${1}c'`,
    ];
    for (const query of queries) {
      throwsAt(() => inline(query), 0);
    }
  });

  await it('rejects raw quote wrapping and unterminated contexts', () => {
    throwsAt(() => inline(sql`${raw("'")}${'v'}${raw("'")}`), 0);
    throwsAt(() => inline(sql`${raw('$$')}${'v'}${raw('$$')}`), 0);
    throwsAt(() => inline(sql`SELECT 'abc`), undefined);
    throwsAt(() => inline(sql`SELECT ${1} /* abc`), undefined);
  });

  await it('accepts values after closed contexts and rejects malformed queries', () => {
    assert.strictEqual(
      inline(sql`SELECT '?' /* x */ ${1}`),
      "SELECT '?' /* x */ 1",
    );
    assert.strictEqual(inline(sql`SELECT $$a'b$$, ${1}`), "SELECT $$a'b$$, 1");

    const extraValue = sql`SELECT ${1}`;
    extraValue.values.push(2);
    throwsAt(() => inline(extraValue), undefined);
    throwsAt(() => inline(null as never), undefined);
  });

  await it('never mutates the input and is deterministic', () => {
    const query = sql`SELECT ${DATE}, ${1n}, ${new Uint8Array([1])} -- tail`;
    const strings = [...query.strings];
    const values = [...query.values];
    const first = inline(query);
    assert.strictEqual(inline(query), first);
    assert.strictEqual(inline(structuredClone<Sql>(query)), first);
    assert.deepStrictEqual(query.strings, strings);
    assert.deepStrictEqual(query.values, values);
  });
});

/** `bind().sqlText` with each `?` replaced by the inline literal of its bind value. */
function viaBind(query: Sql): string {
  const { sqlText, binds } = bind(query);
  let next = 0;
  return sqlText.replaceAll('?', () =>
    inline(sql`${(binds as SnowflakeBind[])[next++]}`),
  );
}

void describe('snowflake bind and inline parity', async () => {
  await it('inline equals bind with literals substituted (non-bytes, non-bigint values)', () => {
    const query = sql`SELECT ${null}, ${true}, ${-1.5}, ${"it's \\"}, ${DATE} WHERE x IN (${join([1, 'a', false])}) AND y = ${"\\'; --"}`;
    assert.strictEqual(viaBind(query), inline(query));
  });

  await it('holds for arbitrary strings', () => {
    fc.assert(
      fc.property(hostileText, hostileText, (a, b) => {
        const query = sql`SELECT ${a}, ${b} -- end`;
        assert.strictEqual(viaBind(query), inline(query));
      }),
      { numRuns: 300 },
    );
  });

  await it('differs only where the types differ by design: bigint and bytes', () => {
    // bind sends digits as text; inline emits a number literal. Bytes need TO_BINARY in both.
    assert.strictEqual(bind(sql`SELECT ${7n}`).binds[0], '7');
    assert.strictEqual(lit(7n), '7');
    assert.strictEqual(
      bind(sql`SELECT ${new Uint8Array([1])}`).sqlText,
      "SELECT TO_BINARY(?, 'HEX')",
    );
    assert.strictEqual(lit(new Uint8Array([1])), "TO_BINARY('01', 'HEX')");
  });
});

interface FakeExecuteOptions extends SnowflakeStatement {
  complete: (
    error: Error | undefined,
    statement: object,
    rows: unknown[],
  ) => void;
}

void describe('snowflake execute contract', async () => {
  await it('spreads into connection.execute next to complete', () => {
    const calls: FakeExecuteOptions[] = [];
    const connection = {
      execute(options: FakeExecuteOptions): void {
        calls.push(options);
        options.complete(undefined, {}, []);
      },
    };
    let completed = 0;
    const complete = (): void => {
      completed++;
    };

    connection.execute({
      ...bind(sql`SELECT ${1} WHERE n = ${'x'}`),
      complete,
    });

    assert.strictEqual(completed, 1);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(Object.keys(calls[0] as object).toSorted(), [
      'binds',
      'complete',
      'sqlText',
    ]);
    assert.strictEqual(calls[0]?.sqlText, 'SELECT ? WHERE n = ?');
    assert.deepStrictEqual(calls[0]?.binds, [1, 'x']);
  });

  await it('only yields primitive binds', () => {
    const { binds } = bind(
      sql`SELECT ${null}, ${true}, ${1}, ${'s'}, ${1n}, ${DATE}, ${new Uint8Array([1])}`,
    );
    for (const value of binds) {
      assert.ok(
        value === null ||
          ['string', 'number', 'boolean'].includes(typeof value),
      );
    }
  });
});

void describe('snowflake consumer contract', async () => {
  const luxon = LUXON;
  const coerce = toIso;

  await it('IN (${join(values)})', () => {
    assert.deepStrictEqual(
      bind(sql`SELECT * FROM t WHERE id IN (${join([1, 'a', DATE, luxon])})`, {
        coerce,
      }),
      {
        sqlText: 'SELECT * FROM t WHERE id IN (?,?,?,?)',
        binds: [1, 'a', DATE_ISO, DATE_ISO],
      },
    );
  });

  await it('ARRAY_CONSTRUCT(${join(values)})', () => {
    assert.deepStrictEqual(
      bind(sql`SELECT ARRAY_CONSTRUCT(${join(['a', 'b', null])})`),
      { sqlText: 'SELECT ARRAY_CONSTRUCT(?,?,?)', binds: ['a', 'b', null] },
    );
  });

  await it('LIKE with %${v}% binds the wildcards inside one string', () => {
    const needle = "50%_off'";
    assert.deepStrictEqual(
      bind(sql`SELECT * FROM t WHERE name LIKE ${`%${needle}%`}`),
      {
        sqlText: 'SELECT * FROM t WHERE name LIKE ?',
        binds: ["%50%_off'%"],
      },
    );
  });

  await it('session SET (${join(names.map(bareIdentifier), ", ")}) = (${join(binds)})', () => {
    const names = ['TENANT_ID', 'REQUEST_ID', 'DEADLINE'];
    const binds = ['t-1', null, luxon];
    assert.deepStrictEqual(
      bind(
        sql`SET (${join(names.map(bareIdentifier), ', ')}) = (${join(binds)})`,
        { coerce },
      ),
      {
        sqlText: 'SET (TENANT_ID, REQUEST_ID, DEADLINE) = (?,?,?)',
        binds: ['t-1', null, DATE_ISO],
      },
    );
    throwsAt(
      () => bind(sql`SET (${join(['a b', 'c'].map(bareIdentifier))}) = (1)`),
      undefined,
    );
  });

  await it('SHOW … IN ${identifier([db, schema, view])}', () => {
    assert.deepStrictEqual(
      bind(sql`SHOW COLUMNS IN VIEW ${identifier(['MY_DB', 'public', 'v"1'])}`),
      { sqlText: 'SHOW COLUMNS IN VIEW "MY_DB"."public"."v""1"', binds: [] },
    );
  });

  await it('IDENTIFIER(${name}) binds a name string', () => {
    assert.deepStrictEqual(bind(sql`SELECT * FROM IDENTIFIER(${'DB.S.T'})`), {
      sqlText: 'SELECT * FROM IDENTIFIER(?)',
      binds: ['DB.S.T'],
    });
  });

  await it('CALL fqn(PARSE_JSON(?)) via variant', () => {
    const payload = { id: 1, tags: ['a', "b'c"], when: DATE };
    assert.deepStrictEqual(
      bind(sql`CALL ${bareIdentifier('p')}(${variant(payload)})`),
      { sqlText: 'CALL p(PARSE_JSON(?))', binds: [JSON.stringify(payload)] },
    );
  });
});
