'use strict';

// Loads the built package through its own `exports` map (self-reference).
const assert = require('node:assert/strict');

const pkg = require('@ziptie-soft/sql-template-tag');

const query = pkg.default`SELECT * FROM books WHERE id IN (${pkg.join([1, 2])})`;
assert.equal(query.text, 'SELECT * FROM books WHERE id IN ($1,$2)');
assert.deepEqual(query.values, [1, 2]);
assert.ok(query instanceof pkg.Sql);
assert.ok(pkg.empty instanceof pkg.Sql);
assert.ok(pkg.raw('x') instanceof pkg.Sql);
assert.ok(pkg.bulk([[1]]) instanceof pkg.Sql);

// The `./pinot` subpath shares the one core `Sql` class with the other format.
const pinot = require('@ziptie-soft/sql-template-tag/pinot');

const ident = pinot.identifier('x');
assert.ok(ident instanceof pkg.Sql);
const nested = pkg.default`SELECT ${ident} FROM t WHERE a = ${1}`;
assert.equal(nested.text, 'SELECT "x" FROM t WHERE a = $1');
assert.deepEqual(nested.values, [1]);
assert.equal(pinot.inline(nested), 'SELECT "x" FROM t WHERE a = 1');

// Same for `./snowflake`.
const snowflake = require('@ziptie-soft/sql-template-tag/snowflake');

const sfIdent = snowflake.identifier('x');
assert.ok(sfIdent instanceof pkg.Sql);
const sfNested = pkg.default`SELECT ${sfIdent} FROM t WHERE a = ${1}`;
assert.deepEqual(snowflake.bind(sfNested), {
  sqlText: 'SELECT "x" FROM t WHERE a = ?',
  binds: [1],
});

// Rendering through both subpaths.
assert.equal(
  pinot.inline(pkg.default`SELECT ${"it's"}, ${'a\\b'}`),
  "SELECT 'it''s', 'a\\b'",
);
assert.equal(
  snowflake.inline(pkg.default`SELECT ${"it's"}, ${'a\\b'}`),
  "SELECT 'it''s', 'a\\\\b'",
);

// `SqlDialectError` is one class across both subpaths.
assert.equal(pinot.SqlDialectError, snowflake.SqlDialectError);
for (const render of [
  () => pinot.inline(pkg.default`SELECT ${undefined}`),
  () => snowflake.bind(pkg.default`SELECT ${undefined}`),
]) {
  assert.throws(render, (error) => {
    assert.ok(error instanceof pinot.SqlDialectError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.index, 0);
    return true;
  });
}

import('@ziptie-soft/sql-template-tag')
  .then(async (esm) => {
    assert.ok(ident instanceof esm.Sql);
    assert.ok(sfIdent instanceof esm.Sql);
    const mixed = esm.default`SELECT ${ident}`;
    assert.equal(mixed.text, 'SELECT "x"');
    assert.deepEqual(mixed.values, []);
    const sfEsm = await import('@ziptie-soft/sql-template-tag/snowflake');
    assert.equal(
      sfEsm.bind(esm.default`SELECT ${sfEsm.identifier('y')}`).sqlText,
      'SELECT "y"',
    );

    // Fragments from the ESM entries nest in the CommonJS `sql` and are treated as text.
    const pinotEsm = await import('@ziptie-soft/sql-template-tag/pinot');
    const fromEsm = pkg.default`SELECT ${pinotEsm.identifier('z')}, ${sfEsm.identifier('w')} FROM t WHERE a = ${1}`;
    assert.equal(fromEsm.text, 'SELECT "z", "w" FROM t WHERE a = $1');
    assert.deepEqual(fromEsm.values, [1]);

    // Same error classes in both formats.
    assert.equal(pinotEsm.SqlDialectError, pinot.SqlDialectError);
    assert.equal(sfEsm.SqlDialectError, snowflake.SqlDialectError);
    assert.throws(
      () => sfEsm.bind(pkg.default`SELECT ${undefined}`),
      pinot.SqlDialectError,
    );
    console.log('cjs smoke ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
