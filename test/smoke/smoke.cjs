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

import('@ziptie-soft/sql-template-tag')
  .then((esm) => {
    assert.ok(ident instanceof esm.Sql);
    const mixed = esm.default`SELECT ${ident}`;
    assert.equal(mixed.text, 'SELECT "x"');
    assert.deepEqual(mixed.values, []);
    console.log('cjs smoke ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
