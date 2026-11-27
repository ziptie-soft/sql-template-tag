import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import sql, { join, raw, type Sql } from '../../src/index.js';
import { SqlDialectError } from '../../src/internal/errors.js';
import {
  assertValueBoundaries,
  type LexerConfig,
  PINOT_LEXER,
  SNOWFLAKE_BIND_LEXER,
  SNOWFLAKE_INLINE_LEXER,
} from '../../src/internal/lexer.js';

const ALL = [PINOT_LEXER, SNOWFLAKE_BIND_LEXER, SNOWFLAKE_INLINE_LEXER];
const SNOWFLAKE = [SNOWFLAKE_BIND_LEXER, SNOWFLAKE_INLINE_LEXER];

type Input = Sql | readonly string[];

function chunks(input: Input): readonly string[] {
  return Array.isArray(input) ? input : (input as Sql).strings;
}

function ok(input: Input, configs: readonly LexerConfig[] = ALL): void {
  for (const cfg of configs) {
    assert.doesNotThrow(
      () => assertValueBoundaries(chunks(input), cfg),
      `${cfg.dialect} ${JSON.stringify(chunks(input))}`,
    );
  }
}

function rejects(
  input: Input,
  reason: string,
  index: number | undefined,
  configs: readonly LexerConfig[] = ALL,
): void {
  for (const cfg of configs) {
    assert.throws(
      () => assertValueBoundaries(chunks(input), cfg),
      (error: unknown) => {
        assert.ok(error instanceof SqlDialectError);
        assert.strictEqual(error.dialect, cfg.dialect);
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.index, index);
        return true;
      },
      `${cfg.dialect} ${JSON.stringify(chunks(input))}`,
    );
  }
}

const v = 1;

void describe('lexer configs', async () => {
  await it('are frozen with the documented switches', () => {
    for (const cfg of ALL) {
      assert.ok(Object.isFrozen(cfg));
    }

    assert.deepStrictEqual(
      { ...PINOT_LEXER },
      {
        dialect: 'pinot',
        backslashInStrings: false,
        dollarQuoted: false,
        slashSlashComment: false,
        backtick: true,
        forbidBareQuestionMark: false,
      },
    );
    assert.deepStrictEqual(
      { ...SNOWFLAKE_BIND_LEXER },
      {
        dialect: 'snowflake',
        backslashInStrings: true,
        dollarQuoted: true,
        slashSlashComment: true,
        backtick: true,
        forbidBareQuestionMark: true,
      },
    );
    assert.deepStrictEqual(
      { ...SNOWFLAKE_INLINE_LEXER },
      { ...SNOWFLAKE_BIND_LEXER, forbidBareQuestionMark: false },
    );
  });
});

void describe('assertValueBoundaries', async () => {
  await it('accepts values in plain text', () => {
    ok([]);
    ok(['']);
    ok(sql`SELECT * FROM t WHERE a = ${v} AND b IN (${join([1, 2, 3])})`);
    ok(sql`${v}${v}${v}`);
    ok(sql`SELECT 'a', "b", \`c\`, /* d */ ${v} -- e\n, ${v}`);
    ok(sql`SELECT 'it''s' ${v}`);
    ok(sql`SELECT "a""b" ${v}`);
    ok(sql`SELECT \`a\`\`b\` ${v}`);
    ok(sql`SELECT 'a\\\\' ${v}`, SNOWFLAKE);
    ok(sql`SELECT 'é—🙂' ${v} 'ü'`);
  });

  await it('rejects a value inside each context', () => {
    rejects(sql`'a ${v} b'`, 'value inside string literal', 0);
    rejects(sql`${v} "a ${v} b"`, 'value inside quoted identifier', 1);
    rejects(sql`\`a ${v} b\``, 'value inside backtick identifier', 0);
    rejects(sql`-- ${v}\n`, 'value inside line comment', 0);
    rejects(sql`/* ${v} */`, 'value inside block comment', 0);
    rejects(sql`// ${v}\n`, 'value inside line comment', 0, SNOWFLAKE);
    rejects(sql`$$ ${v} $$`, 'value inside dollar-quoted string', 0, SNOWFLAKE);
  });

  await it('treats Snowflake-only syntax as plain text in Pinot', () => {
    ok(sql`SELECT 4 // ${v}`, [PINOT_LEXER]);
    ok(sql`SELECT $$ ${v} $$`, [PINOT_LEXER]);
  });

  await it('treats backticks as plain text when disabled', () => {
    const noBacktick: LexerConfig = Object.freeze({
      ...PINOT_LEXER,
      backtick: false,
    });
    ok(sql`SELECT \` ${v} \``, [noBacktick]);
    rejects(sql`SELECT \` ${v} \``, 'value inside backtick identifier', 0, [
      PINOT_LEXER,
    ]);
  });

  await it('rejects unterminated contexts at the end without an index', () => {
    rejects(sql`SELECT ${v} 'abc`, 'unterminated string literal', undefined);
    rejects(sql`SELECT "abc`, 'unterminated quoted identifier', undefined);
    rejects(sql`SELECT \`abc`, 'unterminated backtick identifier', undefined);
    rejects(sql`SELECT ${v} /* x`, 'unterminated block comment', undefined);
    rejects(sql`SELECT /* /* */`, 'unterminated block comment', undefined);
    rejects(
      sql`SELECT ${v} $$ x`,
      'unterminated dollar-quoted string',
      undefined,
      SNOWFLAKE,
    );
    rejects(
      sql`SELECT 'a\\'`,
      'unterminated string literal',
      undefined,
      SNOWFLAKE,
    );
    rejects(
      ['SELECT $$'],
      'unterminated dollar-quoted string',
      undefined,
      SNOWFLAKE,
    );
  });

  await it('allows a trailing line comment without a newline', () => {
    ok(sql`SELECT ${v} -- c`);
    ok(sql`SELECT ${v} --`);
    ok(sql`SELECT ${v} // c`, SNOWFLAKE);
  });

  await it('ends a line comment only at LF', () => {
    ok(sql`-- c\n${v}`);
    ok(sql`-- c\r\n${v}`);
    ok(sql`// c\n${v}`, SNOWFLAKE);
    rejects(sql`-- c\r${v}`, 'value inside line comment', 0);
    rejects(sql`-- c ${v}`, 'value inside line comment', 0);
  });

  await it('counts block comment nesting depth', () => {
    rejects(sql`/* /* */ ${v} */`, 'value inside block comment', 0);
    ok(sql`/* /* */ */ ${v}`);
    ok(sql`/**/ ${v}`);
    ok(sql`/***/ ${v}`);
    ok(sql`/* ' " \` -- */ ${v}`);
    rejects(sql`/*/ ${v} */`, 'value inside block comment', 0);
    ok(sql`*/ ${v}`);
  });

  await it('ignores openers inside other contexts', () => {
    ok(sql`'--' ${v} '/*' ${v} '"' ${v}`);
    ok(sql`"'" ${v} "--" ${v}`);
    ok(sql`-- ' " /*\n${v}`);
    ok(sql`'$$' ${v} '//' ${v}`, SNOWFLAKE);
    ok(sql`$$ ' " -- /* $$ ${v}`, SNOWFLAKE);
  });

  await it('handles quote escapes per dialect', () => {
    ok(sql`SELECT 'it''s' ${v}`);
    ok(sql`SELECT 'it\\'s' ${v}`, SNOWFLAKE);
    // Calcite has no backslash escapes: `\'` closes the literal and `s'` reopens one.
    rejects(sql`SELECT 'it\\'s' ${v}`, 'value inside string literal', 0, [
      PINOT_LEXER,
    ]);
    ok(sql`SELECT 'a\\\\' ${v}`);
    ok(sql`SELECT 'a\\' ${v}`, [PINOT_LEXER]);
    rejects(
      sql`SELECT 'a\\' ${v}`,
      'value inside string literal',
      0,
      SNOWFLAKE,
    );
    ok(sql`SELECT "a""b" ${v}`);
    // Backslashes never escape inside identifiers.
    ok(sql`SELECT "a\\" ${v}`);
    ok(sql`SELECT \`a\\\` ${v}`);
  });

  await it('lexes raw() text', () => {
    rejects(sql`${raw("'")}${v}${raw("'")}`, 'value inside string literal', 0);
    rejects(sql`SELECT ${raw('--')}${v}`, 'value inside line comment', 0);
    rejects(sql`SELECT ${raw('/*')} ${v} */`, 'value inside block comment', 0);
    ok(sql`SELECT ${raw("'a'")} = ${v}`);
  });

  await it('never looks ahead across a value boundary', () => {
    ok(['-', '-']);
    ok(['/', '*']);
    ok(['/', '/']);
    ok(['$', '$'], SNOWFLAKE);
    ok(['*/', '']);
    rejects(["'", "'"], 'value inside string literal', 0);
    rejects(['"', '"'], 'value inside quoted identifier', 0);
    // A doubled quote split by a value is a closing quote followed by a new literal.
    rejects(["'a'", "'"], 'unterminated string literal', undefined);
    // A comment closer split by a value does not close the comment.
    rejects(['/* *', '/'], 'value inside block comment', 0);
    rejects(['$$ $', '$'], 'value inside dollar-quoted string', 0, SNOWFLAKE);
    // A backslash at the end of a chunk leaves the string open.
    rejects(["'\\", "'"], 'value inside string literal', 0, SNOWFLAKE);
  });

  await it('rejects a bare `?` only in Snowflake bind mode', () => {
    rejects(
      sql`SELECT ? , ${v}`,
      'bare `?` placeholder in template text (chunk 0); use a value instead',
      undefined,
      [SNOWFLAKE_BIND_LEXER],
    );
    rejects(
      sql`SELECT ${v}, ?`,
      'bare `?` placeholder in template text (chunk 1); use a value instead',
      undefined,
      [SNOWFLAKE_BIND_LEXER],
    );
    ok(sql`SELECT ? , ${v} ??`, [PINOT_LEXER, SNOWFLAKE_INLINE_LEXER]);
    ok(sql`SELECT '?', "?", \`?\`, $$?$$ -- ?\n /* ? */ // ?\n${v}`, SNOWFLAKE);
    ok(sql`SELECT '?', "?", -- ?\n /* ? */ ${v}`);
  });

  await it('opens `$$` only after a non-identifier character', () => {
    ok(sql`SELECT a$$b ${v}`, SNOWFLAKE);
    ok(sql`SELECT _$$ ${v} x$$ ${v} x$$$ ${v} $a$$ ${v}`, SNOWFLAKE);
    // Digits do not suppress `$$`, so `1$$` opens a dollar-quoted string.
    rejects(
      sql`SELECT 1$$ ${v} $$`,
      'value inside dollar-quoted string',
      0,
      SNOWFLAKE,
    );
    // `a1$$` is an identifier in Snowflake, but treating it as an opener only rejects more
    // templates (fails closed), never lets a value land inside a string.
    rejects(
      sql`SELECT a1$$ ${v}`,
      'value inside dollar-quoted string',
      0,
      SNOWFLAKE,
    );
    rejects(
      sql`SELECT $$$ ${v}`,
      'value inside dollar-quoted string',
      0,
      SNOWFLAKE,
    );
    ok(sql`SELECT $$x$$ ${v}`, SNOWFLAKE);
    ok(sql`SELECT $$ ' $$ ${v}`, SNOWFLAKE);
    ok(sql`SELECT ($$x$$) ${v}`, SNOWFLAKE);
    ok(sql`$$x$$${v}`, SNOWFLAKE);
    ok(sql`SELECT $1, $ ${v}`, SNOWFLAKE);
    rejects(
      sql`SELECT é$$ ${v} $$`,
      'value inside dollar-quoted string',
      0,
      SNOWFLAKE,
    );
    rejects(
      sql`SELECT ${v}$$ ${v} $$`,
      'value inside dollar-quoted string',
      1,
      SNOWFLAKE,
    );
  });

  await it('handles long runs of openers and closers', () => {
    ok(["''''''", "''", ''], ALL);
    ok(['$$$$', '$$$$$$$$'], SNOWFLAKE);
    ok(['----\n', '----'], ALL);
    ok(['/*/**/*/', '*/ /**/'], ALL);
    rejects(['/*/*/*', ''], 'value inside block comment', 0);
  });
});

function time(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** Best of `runs` timings after a warm-up run. */
function measure(fn: () => void, runs = 5): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    best = Math.min(best, time(fn));
  }

  return best;
}

function attempt(strings: readonly string[], cfg: LexerConfig): () => void {
  return () => {
    try {
      assertValueBoundaries(strings, cfg);
    } catch (error) {
      assert.ok(error instanceof SqlDialectError);
    }
  };
}

const MB = 1 << 20;

function fill(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** About 100 KB of mixed SQL split by `boundaries` values. */
function typicalTemplate(boundaries: number): string[] {
  const piece =
    "SELECT \"col\", 'it''s', `bt` /* note */ FROM t -- c\nWHERE a = ";
  const chunk = piece.repeat(
    Math.ceil((100 * 1024) / boundaries / piece.length),
  );
  return Array.from({ length: boundaries + 1 }, () => chunk);
}

void describe('lexer performance', async () => {
  await it('lexes 100 KB with ~1000 boundaries quickly', (t: TestContext) => {
    const strings = typicalTemplate(1000);
    const bytes = strings.reduce((n, s) => n + s.length, 0);
    assert.ok(bytes >= 100 * 1024);
    for (const cfg of ALL) {
      const ms = measure(() => assertValueBoundaries(strings, cfg));
      t.diagnostic(`100 KB ${cfg.dialect}: ${ms.toFixed(3)} ms`);
      assert.ok(ms < 50, `${ms} ms`);
    }
  });

  await it('lexes adversarial inputs up to 1 MB in linear time', (t: TestContext) => {
    const cases: [string, readonly string[], LexerConfig][] = [
      ["'", [fill("'", MB)], PINOT_LEXER],
      ["''''", [fill("''''", MB - 1) + "'"], PINOT_LEXER],
      ['\\\\ in string', ["'" + fill('\\\\', MB) + "'"], SNOWFLAKE_BIND_LEXER],
      ["\\' in string", ["'" + fill("\\'", MB)], SNOWFLAKE_BIND_LEXER],
      ['/*/*/*', [fill('/*', MB)], PINOT_LEXER],
      ['*/*/', [fill('*/', MB)], PINOT_LEXER],
      ['$$$$', [fill('$', MB)], SNOWFLAKE_BIND_LEXER],
      ['----', [fill('-', MB)], PINOT_LEXER],
      ['////', [fill('/', MB)], SNOWFLAKE_BIND_LEXER],
      ['plain', [fill('a', MB)], SNOWFLAKE_BIND_LEXER],
      [
        '100k chunks',
        Array.from({ length: 100_000 }, () => ' a '),
        PINOT_LEXER,
      ],
      [
        '100k quoted chunks',
        Array.from({ length: 100_000 }, () => "'x''y' "),
        SNOWFLAKE_BIND_LEXER,
      ],
      [
        '100k empty chunks',
        Array.from({ length: 100_000 }, () => ''),
        PINOT_LEXER,
      ],
    ];
    for (const [name, strings, cfg] of cases) {
      const ms = measure(attempt(strings, cfg), 3);
      const kb = strings.reduce((n, s) => n + s.length, 0) / 1024;
      t.diagnostic(
        `${kb.toFixed(0)} KB ${name} (${cfg.dialect}): ${ms.toFixed(3)} ms`,
      );
      assert.ok(ms < 500, `${name}: ${ms} ms`);
    }
  });
});
