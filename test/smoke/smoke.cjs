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

console.log('cjs smoke ok');
