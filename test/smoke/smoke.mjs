import sql, {
  bulk,
  empty,
  join,
  raw,
  Sql,
} from '@ziptie-soft/sql-template-tag';
// Loads the built package through its own `exports` map (self-reference),
// and checks that ESM and CJS share a single `Sql` class.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url)('@ziptie-soft/sql-template-tag');

const query = sql`SELECT * FROM books WHERE id IN (${join([1, 2])})`;
assert.equal(query.text, 'SELECT * FROM books WHERE id IN ($1,$2)');
assert.deepEqual(query.values, [1, 2]);
assert.ok(query instanceof Sql);
assert.ok(empty instanceof Sql);
assert.ok(raw('x') instanceof Sql);
assert.ok(bulk([[1]]) instanceof Sql);

assert.equal(Sql, cjs.Sql);
assert.ok(cjs.default`SELECT 1` instanceof Sql);
assert.ok(query instanceof cjs.Sql);

// The `./pinot` subpath shares the one core `Sql` class with the other format.
const { identifier, inline } =
  await import('@ziptie-soft/sql-template-tag/pinot');

const ident = identifier('x');
assert.ok(ident instanceof Sql);
assert.ok(ident instanceof cjs.Sql);
const nested = cjs.default`SELECT ${ident} FROM t WHERE a = ${1}`;
assert.equal(nested.text, 'SELECT "x" FROM t WHERE a = $1');
assert.deepEqual(nested.values, [1]);
assert.equal(inline(nested), 'SELECT "x" FROM t WHERE a = 1');

// Same for `./snowflake`.
const snowflake = await import('@ziptie-soft/sql-template-tag/snowflake');

const sfIdent = snowflake.identifier('x');
assert.ok(sfIdent instanceof Sql);
assert.ok(sfIdent instanceof cjs.Sql);
const sfNested = cjs.default`SELECT ${sfIdent} FROM t WHERE a = ${1}`;
assert.deepEqual(snowflake.bind(sfNested), {
  sqlText: 'SELECT "x" FROM t WHERE a = ?',
  binds: [1],
});
assert.equal(
  snowflake.bind(sql`SELECT ${snowflake.variant({ a: 1 })}`).sqlText,
  'SELECT PARSE_JSON(?)',
);

// Rendering through both subpaths.
assert.equal(
  inline(sql`SELECT ${"it's"}, ${'a\\b'}`),
  "SELECT 'it''s', 'a\\b'",
);
assert.equal(
  snowflake.inline(sql`SELECT ${"it's"}, ${'a\\b'}`),
  "SELECT 'it''s', 'a\\\\b'",
);

// Fragments from the CommonJS entries nest in the ESM `sql` and are treated as text.
const require = createRequire(import.meta.url);
const cjsPinot = require('@ziptie-soft/sql-template-tag/pinot');
const cjsSnowflake = require('@ziptie-soft/sql-template-tag/snowflake');
const fromCjs = sql`SELECT ${cjsPinot.identifier('z')}, ${cjsSnowflake.identifier('w')} FROM t WHERE a = ${1}`;
assert.equal(fromCjs.text, 'SELECT "z", "w" FROM t WHERE a = $1');
assert.deepEqual(fromCjs.values, [1]);

// `SqlDialectError` is one class across both subpaths and both formats.
const { SqlDialectError } = snowflake;
assert.equal(SqlDialectError, cjsPinot.SqlDialectError);
assert.equal(SqlDialectError, cjsSnowflake.SqlDialectError);
assert.equal(
  SqlDialectError,
  (await import('@ziptie-soft/sql-template-tag/pinot')).SqlDialectError,
);
for (const render of [
  () => inline(sql`SELECT ${undefined}`),
  () => snowflake.bind(sql`SELECT ${undefined}`),
  () => cjsPinot.inline(sql`SELECT ${undefined}`),
]) {
  assert.throws(render, (error) => {
    assert.ok(error instanceof SqlDialectError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.index, 0);
    return true;
  });
}

console.log('esm smoke ok');
