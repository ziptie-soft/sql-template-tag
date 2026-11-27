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

console.log('esm smoke ok');
