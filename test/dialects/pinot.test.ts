import * as fc from 'fast-check';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  array,
  bareIdentifier,
  identifier,
  inline,
  type PinotInlineOptions,
  queryOptions,
  SqlDialectError,
} from '../../src/dialects/pinot.js';
import sql, { bulk, empty, join, raw, Sql } from '../../src/index.js';
import {
  quotedIdentifiers,
  statementCount,
  stringLiterals,
  summarize,
  tokenizePinot,
} from './tokenizers.js';

function throwsAt(fn: () => unknown, index: number | undefined): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SqlDialectError, String(error));
    assert.strictEqual(error.dialect, 'pinot');
    assert.strictEqual(error.index, index);
    return true;
  });
}

/** Render one value after `SELECT `, so no fusion guard is involved. */
function one(value: unknown, options?: PinotInlineOptions): string {
  return inline(sql`SELECT ${value}`, options).slice('SELECT '.length);
}

function optionsSql(options: Parameters<typeof queryOptions>[0]): string {
  return queryOptions(options).sql;
}

const DATE = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6));

void describe('pinot inline scalars', async () => {
  await it('renders null and booleans', () => {
    assert.strictEqual(one(null), 'NULL');
    assert.strictEqual(one(true), 'TRUE');
    assert.strictEqual(one(false), 'FALSE');
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
      assert.strictEqual(one(value), expected);
    }
  });

  await it('rejects unsafe integers, NaN and infinities with the value index', () => {
    for (const value of [2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity]) {
      throwsAt(() => inline(sql`SELECT ${1}, ${value}`), 1);
    }
  });

  await it('renders bigint as digits', () => {
    assert.strictEqual(one(0n), '0');
    assert.strictEqual(one(-(2n ** 63n)), '-9223372036854775808');
    assert.strictEqual(one(2n ** 64n), '18446744073709551616');
  });

  await it('quotes strings with doubled quotes only', () => {
    const cases: [string, string][] = [
      ['', "''"],
      ['abc', "'abc'"],
      ["it's", "'it''s'"],
      ["'", "''''"],
      ['héllo 🙂 日本', "'héllo 🙂 日本'"],
      ['a\nb\r\nc', "'a\nb\r\nc'"],
      ['back\\slash', "'back\\slash'"],
      ['\\', "'\\'"],
      ['a"b', "'a\"b'"],
      ['\x1a', "'\x1a'"],
      ['\ud800', "'\ud800'"],
    ];
    for (const [value, expected] of cases) {
      assert.strictEqual(one(value), expected);
    }
  });

  await it('rejects NUL in strings with the value index', () => {
    throwsAt(() => inline(sql`SELECT ${1}, ${'a\0b'}`), 1);
    throwsAt(() => inline(sql`SELECT ${'\0'}`), 0);
  });

  await it('renders dates as UTC strings by default', () => {
    assert.strictEqual(one(DATE), "'2024-01-02 03:04:05.006'");
    assert.strictEqual(
      one(DATE, { dateStyle: 'string' }),
      "'2024-01-02 03:04:05.006'",
    );
  });

  await it('renders dates per dateStyle', () => {
    assert.strictEqual(
      one(DATE, { dateStyle: 'epochMillis' }),
      String(DATE.getTime()),
    );
    assert.strictEqual(
      one(DATE, { dateStyle: 'timestamp' }),
      "CAST('2024-01-02 03:04:05.006' AS TIMESTAMP)",
    );
    assert.strictEqual(one(new Date(0), { dateStyle: 'epochMillis' }), '0');
  });

  await it('rejects invalid and out-of-range dates under every dateStyle', () => {
    for (const dateStyle of ['string', 'epochMillis', 'timestamp'] as const) {
      throwsAt(() => one(new Date(NaN), { dateStyle }), 0);
      throwsAt(() => one(new Date(8.64e15), { dateStyle }), 0);
    }
  });

  await it('renders bytes as X literals', () => {
    assert.strictEqual(one(new Uint8Array([])), "X''");
    assert.strictEqual(one(new Uint8Array([0, 255])), "X'00ff'");
    assert.strictEqual(one(Buffer.from([1, 2, 171])), "X'0102ab'");
  });
});

void describe('pinot inline rejections', async () => {
  class Custom {
    readonly a = 1;
  }

  const rejected: [string, unknown][] = [
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

  await it('throws SqlDialectError with the value index', () => {
    for (const [name, value] of rejected) {
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
  });

  await it('reports the flattened index of values in nested fragments', () => {
    throwsAt(() => inline(sql`SELECT ${join([1, undefined])}`), 1);
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
});

void describe('pinot inline coerce', async () => {
  const luxon = { toISO: (): string => '2024-01-02T03:04:05.006Z' };
  const coerce = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'toISO' in value
      ? (value as typeof luxon).toISO()
      : value;

  await it('maps custom objects to supported literals', () => {
    assert.strictEqual(
      inline(sql`SELECT ${luxon}, ${1}, ${'a'}`, { coerce }),
      "SELECT '2024-01-02T03:04:05.006Z', 1, 'a'",
    );
  });

  await it('can map undefined to NULL', () => {
    assert.strictEqual(
      one(undefined, { coerce: (v) => (v === undefined ? null : v) }),
      'NULL',
    );
  });

  await it('cannot smuggle raw SQL: the result is quoted like any string', () => {
    assert.strictEqual(
      one(1, { coerce: () => "x' OR 1=1 --" }),
      "'x'' OR 1=1 --'",
    );
  });

  await it('rejects invalid options', () => {
    const bad: unknown[] = [
      { dateStyle: 'iso' },
      { dateStyle: null },
      { dateStyle: 1 },
      { coerce: 'x' },
      { coerce: null },
      null,
      42,
      'string',
    ];
    for (const options of bad) {
      throwsAt(() => inline(sql`SELECT ${1}`, options as never), undefined);
    }
  });

  await it('accepts empty options', () => {
    assert.strictEqual(inline(sql`SELECT ${1}`, {}), 'SELECT 1');
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
  readonly strings: (value: string) => string[];
  readonly statements: number;
}

const CONTEXTS: readonly Context[] = [
  {
    name: 'sql',
    build: (s) => sql`SELECT ${s}`,
    strings: (s) => [s],
    statements: 1,
  },
  {
    name: 'join',
    build: (s) => sql`SELECT 1 WHERE a IN (${join([s, 'x', s])})`,
    strings: (s) => [s, 'x', s],
    statements: 1,
  },
  {
    name: 'bulk',
    build: (s) =>
      sql`INSERT INTO t VALUES ${bulk([
        [s, 1],
        ['y', s],
      ])}`,
    strings: (s) => [s, 'y', s],
    statements: 1,
  },
  {
    name: 'array',
    build: (s) => sql`SELECT ${array([s, 2])}`,
    strings: (s) => [s],
    statements: 1,
  },
  {
    name: 'queryOptions',
    build: (s) => sql`${queryOptions({ k: s, other: 1 })}SELECT 1`,
    strings: (s) => [s],
    statements: 3,
  },
];

void describe('pinot injection corpus', async () => {
  for (const { name, build, strings, statements } of CONTEXTS) {
    await it(`decodes every value back to one string literal (${name})`, () => {
      for (const value of CORPUS) {
        const text = inline(build(value));
        const tokens = tokenizePinot(text);
        const label = `${JSON.stringify(value)} -> ${JSON.stringify(text)}`;
        assert.deepStrictEqual(stringLiterals(tokens), strings(value), label);
        assert.ok(
          tokens.every(
            (t) => t.kind !== 'comment' && t.kind !== 'unterminated',
          ),
          label,
        );
        assert.strictEqual(statementCount(tokens), statements, label);
      }
    });
  }

  await it('decodes hostile identifiers back to one quoted identifier', () => {
    for (const value of CORPUS) {
      if (value === '') {
        continue;
      }

      const text = inline(sql`SELECT ${identifier(value)} FROM t`);
      const tokens = tokenizePinot(text);
      assert.deepStrictEqual(quotedIdentifiers(tokens), [value], text);
      assert.strictEqual(statementCount(tokens), 1, text);
      assert.ok(
        tokens.every((t) => t.kind !== 'comment'),
        text,
      );
    }
  });

  await it('still rejects NUL in every context', () => {
    for (const { build } of CONTEXTS) {
      assert.throws(() => inline(build('a\0')), SqlDialectError);
    }
  });
});

// Biased towards the characters that matter to the lexer, plus lone surrogates.
const hostileChar = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      "'",
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
      'é',
      '🙂',
      '𐀀',
      '\ud800',
      '\udc00',
    ),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 1 }) },
);
const hostileString = fc
  .string({ unit: hostileChar, maxLength: 40 })
  .filter((s) => !s.includes('\0'));

void describe('pinot round-trip properties', async () => {
  await it('decodes an inlined string back to the input', () => {
    fc.assert(
      fc.property(hostileString, (s) => {
        const tokens = tokenizePinot(inline(sql`SELECT ${s}`));
        assert.deepStrictEqual(stringLiterals(tokens), [s]);
        assert.ok(tokens.every((t) => t.kind !== 'comment'));
        assert.strictEqual(statementCount(tokens), 1);
      }),
      { numRuns: 1000 },
    );
  });

  await it('decodes strings between template text without fusion', () => {
    fc.assert(
      fc.property(hostileString, hostileString, (a, b) => {
        const text = inline(sql`SELECT x=${a}AND y=${b}--tail`);
        const tokens = tokenizePinot(text);
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
        hostileString.filter((s) => s !== ''),
        (s) => {
          const tokens = tokenizePinot(inline(sql`SELECT ${identifier(s)}`));
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
          assert.ok(Number(one(n)) === n, one(n));
        },
      ),
      { numRuns: 500 },
    );
  });

  await it('renders bytes as hex that decodes back to the input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const text = one(bytes);
        assert.ok(/^X'(?:[0-9a-f]{2})*'$/.test(text));
        assert.deepStrictEqual(
          Uint8Array.from(Buffer.from(text.slice(2, -1), 'hex')),
          bytes,
        );
      }),
      { numRuns: 200 },
    );
  });
});

void describe('pinot token fusion', async () => {
  await it('keeps adjacent literals and text apart', () => {
    const cases: [Sql, string[]][] = [
      [sql`a-${-1}`, ['a', '-', '-', '1']],
      [sql`${"a'"}${"b'"}`, ["str(a')", "str(b')"]],
      [sql`X${'41'}`, ['X', 'str(41)']],
      [sql`N${'x'}`, ['N', 'str(x)']],
      [sql`U&${'x'}`, ['U', '&', 'str(x)']],
      [sql`$${1}`, ['$', '1']],
      [sql`t.${5}`, ['t', '.', '5']],
      [sql`${1}e5`, ['1', 'e5']],
      [sql`${'a'}'b'`, ['str(a)', 'str(b)']],
      [sql`${1}x`, ['1', 'x']],
      [sql`a.${'b'}`, ['a', '.', 'str(b)']],
    ];
    for (const [query, expected] of cases) {
      const text = inline(query);
      assert.deepStrictEqual(summarize(text), expected, text);
    }
  });

  await it('does not fuse non-ASCII neighbours', () => {
    assert.deepStrictEqual(summarize(inline(sql`é${1}`)), ['é', '1']);
    assert.deepStrictEqual(summarize(inline(sql`${1}é`)), ['1', 'é']);
  });

  await it('passes other text through byte for byte', () => {
    assert.strictEqual(inline(sql`(${1},${2})`), '(1,2)');
    assert.strictEqual(inline(sql`a = ${1} AND b<${'x'}`), "a = 1 AND b<'x'");
    assert.strictEqual(inline(sql`${1} + 1`), '1 + 1');
    assert.strictEqual(inline(sql`${1}`), '1');
    assert.strictEqual(inline(sql`-- x\n${1}`), '-- x\n1');
    assert.strictEqual(inline(sql`SELECT ${1} -- tail`), 'SELECT 1 -- tail');
  });

  await it('keeps a literal that ends a chunk from fusing with the next literal', () => {
    assert.strictEqual(inline(sql`${'a'}${'b'}`), "'a' 'b'");
    assert.strictEqual(inline(sql`${1}${2}`), '1 2');
    assert.strictEqual(inline(sql`${1},${2}`), '1,2');
  });
});

void describe('pinot context guard', async () => {
  await it('rejects values inside quotes and comments', () => {
    const queries: Sql[] = [
      sql`SELECT '${'v'}'`,
      sql`SELECT 'it''s ${'v'}'`,
      sql`SELECT "${'v'}"`,
      sql`SELECT \`${'v'}\``,
      sql`SELECT 1 -- ${'v'}\n`,
      sql`SELECT 1 /* ${'v'} */`,
      sql`SELECT 'a${'v'}b${1}c'`,
    ];
    for (const query of queries) {
      throwsAt(() => inline(query), 0);
    }
  });

  await it('rejects raw quote wrapping', () => {
    throwsAt(() => inline(sql`${raw("'")}${'v'}${raw("'")}`), 0);
    throwsAt(() => inline(sql`${raw('"')}${'v'}${raw('"')}`), 0);
    throwsAt(() => inline(sql`${raw('/*')}${'v'}${raw('*/')}`), 0);
  });

  await it('rejects unterminated contexts without an index', () => {
    throwsAt(() => inline(sql`SELECT 'abc`), undefined);
    throwsAt(() => inline(sql`SELECT ${1} /* abc`), undefined);
  });

  await it('accepts values after closed contexts', () => {
    assert.strictEqual(
      inline(sql`SELECT '?' /* x */ ${1}`),
      "SELECT '?' /* x */ 1",
    );
    assert.strictEqual(inline(sql`SELECT "a""b", ${1}`), 'SELECT "a""b", 1');
  });
});

void describe('pinot helpers', async () => {
  await it('return plain core Sql instances', () => {
    assert.ok(identifier('a') instanceof Sql);
    assert.ok(identifier(['a', 'b']) instanceof Sql);
    assert.ok(bareIdentifier('a') instanceof Sql);
    assert.ok(array([1]) instanceof Sql);
    assert.ok(queryOptions({ a: 1 }) instanceof Sql);
    assert.strictEqual(queryOptions({}), empty);
  });

  await it('identifier quotes and never splits on dots', () => {
    assert.strictEqual(identifier('a').sql, '"a"');
    assert.strictEqual(identifier('a.b').sql, '"a.b"');
    assert.strictEqual(identifier('a"b').sql, '"a""b"');
    assert.strictEqual(identifier(['schema', 'col']).sql, '"schema"."col"');
    assert.strictEqual(identifier('select').sql, '"select"');
  });

  await it('identifier rejects invalid names', () => {
    const bad: unknown[] = ['', 'a\0', [], [''], ['a', ''], ['a', 1], 1, null];
    for (const name of bad) {
      throwsAt(() => identifier(name as never), undefined);
    }
  });

  await it('bareIdentifier validates and emits verbatim', () => {
    assert.strictEqual(bareIdentifier('abc_1').sql, 'abc_1');
    assert.strictEqual(bareIdentifier('_x').sql, '_x');
    for (const name of [
      '',
      '1a',
      'a-b',
      'a b',
      'a.b',
      'é',
      'a\n',
      'a"',
      "a'",
    ]) {
      throwsAt(() => bareIdentifier(name), undefined);
    }
    throwsAt(() => bareIdentifier(1 as never), undefined);
  });

  await it('array renders ARRAY[…] and carries values', () => {
    const a = array([1, 'a', null]);
    assert.strictEqual(a.sql, 'ARRAY[?,?,?]');
    assert.strictEqual(a.text, 'ARRAY[$1,$2,$3]');
    assert.strictEqual(a.statement, 'ARRAY[:1,:2,:3]');
    assert.deepStrictEqual(a.values, [1, 'a', null]);
    assert.strictEqual(inline(sql`SELECT ${a}`), "SELECT ARRAY[1,'a',NULL]");
    assert.strictEqual(inline(sql`SELECT ${array([7])}`), 'SELECT ARRAY[7]');
    assert.strictEqual(
      inline(sql`SELECT ${array([array([1]), array([2])])}`),
      'SELECT ARRAY[ARRAY[1],ARRAY[2]]',
    );
    assert.strictEqual(
      inline(sql`SELECT ${array([-1, -2])}`),
      'SELECT ARRAY[-1,-2]',
    );
  });

  await it('array rejects empty and non-array input', () => {
    throwsAt(() => array([]), undefined);
    throwsAt(() => array('a' as never), undefined);
    throwsAt(() => array(undefined as never), undefined);
  });

  await it('array elements follow the value rules', () => {
    throwsAt(() => inline(sql`SELECT ${array([1, undefined])}`), 1);
    throwsAt(() => inline(sql`SELECT ${array([[1]])}`), 0);
  });

  await it('queryOptions renders SET lines in insertion order', () => {
    const query = sql`${queryOptions({
      useMultistageEngine: true,
      timeoutMs: 1000,
      s: "a'b",
    })}SELECT 1`;
    assert.strictEqual(
      inline(query),
      "SET useMultistageEngine = true;\nSET timeoutMs = 1000;\nSET s = 'a''b';\nSELECT 1",
    );
  });

  await it('queryOptions handles each value type', () => {
    assert.strictEqual(optionsSql({ a: false }), 'SET a = false;\n');
    assert.strictEqual(optionsSql({ a: -0 }), 'SET a = 0;\n');
    assert.strictEqual(optionsSql({ a: 1.5 }), 'SET a = 1.5;\n');
    assert.strictEqual(
      optionsSql({ a: 2n ** 53n + 1n }),
      'SET a = 9007199254740993;\n',
    );
    assert.strictEqual(optionsSql({ a: '' }), "SET a = '';\n");
    assert.strictEqual(optionsSql({ a: 'x\\y"z\n' }), "SET a = 'x\\y\"z\n';\n");
    assert.strictEqual(optionsSql({ a: undefined, b: 1 }), 'SET b = 1;\n');
    assert.strictEqual(queryOptions({ a: undefined }), empty);
  });

  await it('queryOptions rejects invalid input', () => {
    for (const key of ['', '1a', 'a-b', "a'b", 'a b', 'a=b', 'é']) {
      throwsAt(() => queryOptions({ [key]: 1 }), undefined);
    }

    for (const value of [NaN, Infinity, -Infinity, 2 ** 53]) {
      throwsAt(() => queryOptions({ a: value }), undefined);
    }

    const values: unknown[] = [null, {}, [], new Date(0), Symbol('x'), () => 1];
    for (const value of values) {
      throwsAt(() => queryOptions({ a: value as never }), undefined);
    }

    throwsAt(() => queryOptions({ a: 'x\0' }), undefined);
    for (const options of [null, undefined, [], 'a', 1]) {
      throwsAt(() => queryOptions(options as never), undefined);
    }
  });

  await it('queryOptions strings stay inert when inlined', () => {
    for (const value of CORPUS) {
      const text = inline(sql`${queryOptions({ k: value })}SELECT 1`);
      const tokens = tokenizePinot(text);
      assert.deepStrictEqual(stringLiterals(tokens), [value], text);
      assert.strictEqual(statementCount(tokens), 2, text);
    }
  });

  await it('compose with sql, join, bulk, raw and empty', () => {
    const query = sql`SELECT ${join([identifier('a'), bareIdentifier('b')])} FROM ${identifier(['s', 't'])} WHERE c IN (${array([1, 2])}) AND d IN ${bulk([[1, identifier('x')]])}${empty}${raw('')}`;
    assert.strictEqual(
      inline(query),
      'SELECT "a",b FROM "s"."t" WHERE c IN (ARRAY[1,2]) AND d IN (1,"x")',
    );
    assert.deepStrictEqual(query.values, [1, 2, 1]);
    assert.strictEqual(
      query.text,
      'SELECT "a",b FROM "s"."t" WHERE c IN (ARRAY[$1,$2]) AND d IN ($3,"x")',
    );
  });

  await it('leave core getters untouched on helper fragments', () => {
    const fragment = sql`SELECT ${identifier('a')} FROM t WHERE b = ${1} AND c IN (${array([2, 3])})`;
    assert.deepStrictEqual(fragment.inspect(), {
      sql: 'SELECT "a" FROM t WHERE b = ? AND c IN (ARRAY[?,?])',
      statement: 'SELECT "a" FROM t WHERE b = :1 AND c IN (ARRAY[:2,:3])',
      text: 'SELECT "a" FROM t WHERE b = $1 AND c IN (ARRAY[$2,$3])',
      values: [1, 2, 3],
    });
    const options = queryOptions({ a: 1 });
    assert.deepStrictEqual(options.inspect(), {
      sql: 'SET a = 1;\n',
      statement: 'SET a = 1;\n',
      text: 'SET a = 1;\n',
      values: [],
    });
  });
});

void describe('pinot structural checks', async () => {
  await it('rejects queries whose strings and values disagree', () => {
    const extraValue = sql`SELECT ${1}`;
    extraValue.values.push(2);
    throwsAt(() => inline(extraValue), undefined);

    const missingString = sql`SELECT ${1}`;
    missingString.strings.pop();
    throwsAt(() => inline(missingString), undefined);

    const badString = sql`SELECT ${1}`;
    badString.strings[1] = 1 as never;
    throwsAt(() => inline(badString), undefined);
  });

  await it('rejects non-query inputs', () => {
    for (const query of [
      null,
      undefined,
      'SELECT 1',
      1,
      {},
      { strings: 'a', values: [] },
    ]) {
      throwsAt(() => inline(query as never), undefined);
    }
  });

  await it('accepts structured clones', () => {
    const query = sql`SELECT ${'a'}, ${1}`;
    assert.strictEqual(inline(structuredClone(query)), "SELECT 'a', 1");
  });

  await it('is deterministic and never mutates its input', () => {
    const query = sql`SELECT ${"it's"}, ${1}, ${DATE}`;
    const before = structuredClone(query);
    Object.freeze(query.strings);
    Object.freeze(query.values);
    const first = inline(query);
    assert.strictEqual(inline(query), first);
    assert.deepStrictEqual(query.strings, before.strings);
    assert.deepStrictEqual(query.values, before.values);
  });

  await it('calls coerce exactly once per value', () => {
    let calls = 0;
    const coerce = (value: unknown): unknown => {
      calls++;
      return value;
    };
    inline(sql`${1},${2},${3}`, { coerce });
    assert.strictEqual(calls, 3);
  });
});

void describe('pinot-noir contract scenarios', async () => {
  await it('inlines IN lists built with join', () => {
    assert.strictEqual(
      inline(sql`SELECT * FROM t WHERE c IN (${join(['a', 'b'])})`),
      "SELECT * FROM t WHERE c IN ('a','b')",
    );
  });

  await it('quotes schema-qualified identifiers part by part', () => {
    assert.strictEqual(
      inline(sql`SELECT ${identifier(['schema', 'col'])} FROM t`),
      'SELECT "schema"."col" FROM t',
    );
  });

  await it('keeps backslashes, double quotes and newlines verbatim', () => {
    assert.strictEqual(one('a\\b'), "'a\\b'");
    assert.strictEqual(one('say "hi"'), '\'say "hi"\'');
    assert.strictEqual(one('line1\nline2'), "'line1\nline2'");
  });

  await it('throws on arrays, objects, undefined and invalid dates', () => {
    for (const value of [['a', 'b'], { a: 1 }, undefined, new Date('nope')]) {
      throwsAt(() => one(value), 0);
    }
  });

  await it('renders dates in UTC', () => {
    assert.strictEqual(
      one(new Date('2024-05-06T07:08:09.010Z')),
      "'2024-05-06 07:08:09.010'",
    );
  });

  await it('prepends query options built from an options object', () => {
    const query = sql`SELECT ${1}`;
    assert.strictEqual(
      inline(sql`${queryOptions({ timeoutMs: 500, skip: undefined })}${query}`),
      'SET timeoutMs = 500;\nSELECT 1',
    );
  });
});

void describe('pinot inline: overridden built-in methods', async () => {
  const evil = "2024-01-02 03:04:05.006'); DROP TABLE t; --";

  class EvilDate extends Date {
    override toISOString(): string {
      return evil;
    }

    override getTime(): number {
      return evil as unknown as number;
    }

    override getUTCFullYear(): number {
      return 2000;
    }
  }

  class EvilBytes extends Uint8Array {
    override get length(): number {
      return 4;
    }
  }

  await it('renders dates through the intrinsic Date methods', () => {
    const date = new EvilDate(Date.UTC(2024, 0, 2, 3, 4, 5, 6));
    for (const dateStyle of ['string', 'epochMillis', 'timestamp'] as const) {
      const text = inline(sql`SELECT ${date}`, { dateStyle });
      assert.ok(!text.includes('DROP'), text);
    }

    assert.strictEqual(
      inline(sql`SELECT ${date}`),
      "SELECT '2024-01-02 03:04:05.006'",
    );
    assert.strictEqual(
      inline(sql`SELECT ${date}`, { dateStyle: 'epochMillis' }),
      'SELECT 1704164645006',
    );
  });

  await it('validates the real date, not an overridden year', () => {
    throwsAt(() => inline(sql`SELECT ${new EvilDate(Number.NaN)}`), 0);
    throwsAt(
      () => inline(sql`SELECT ${new EvilDate(Date.UTC(10000, 0, 1))}`),
      0,
    );
  });

  await it('reads the intrinsic length of a byte array subclass', () => {
    assert.strictEqual(
      inline(sql`SELECT ${new EvilBytes([1, 2])}`),
      "SELECT X'0102'",
    );
  });
});
