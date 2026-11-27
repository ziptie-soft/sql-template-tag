# SQL Template Tag (`@ziptie-soft/sql-template-tag`)

[![NPM version][npm-image]][npm-url]
[![NPM downloads][downloads-image]][downloads-url]
[![Build status][build-image]][build-url]
[![Build coverage][coverage-image]][coverage-url]

> ES2015 tagged template string for preparing SQL statements.

A maintained fork of [`sql-template-tag`](https://github.com/blakeembrey/sql-template-tag) by Blake Embrey (MIT). Ships both CommonJS and ESM builds with matching type declarations, and has no runtime dependencies.

## Installation

```
npm install @ziptie-soft/sql-template-tag
```

Requires Node.js 24.11 or newer.

## Usage

Both module systems are supported and share a single `Sql` class, so `instanceof` works across `import` and `require`:

```js
// ESM
import sql, { bulk, empty, join, raw } from '@ziptie-soft/sql-template-tag';

// CommonJS
const {
  default: sql,
  bulk,
  empty,
  join,
  raw,
} = require('@ziptie-soft/sql-template-tag');
```

```js
import sql, { empty, join, raw } from '@ziptie-soft/sql-template-tag';

const query = sql`SELECT * FROM books WHERE id = ${id}`;

query.sql; //=> "SELECT * FROM books WHERE id = ?"
query.text; //=> "SELECT * FROM books WHERE id = $1"
query.statement; //=> "SELECT * FROM books WHERE id = :1"
query.values; //=> [id]

pg.query(query); // Uses `text` and `values`.
mysql.query(query); // Uses `sql` and `values`.
oracledb.execute(query); // Uses `statement` and `values`.

// Embed SQL instances inside SQL instances.
const nested = sql`SELECT id FROM authors WHERE name = ${'Blake'}`;
const query = sql`SELECT * FROM books WHERE author_id IN (${nested})`;

// Join and "empty" helpers (useful for nested queries).
sql`SELECT * FROM books ${hasIds ? sql`WHERE ids IN (${join(ids)})` : empty}`;
```

### Join

Accepts an array of values or SQL, and returns SQL with the values joined together using the separator.

```js
const query = join([1, 2, 3]);

query.sql; //=> "?,?,?"
query.values; //=> [1, 2, 3]
```

**Tip:** You can set the second argument to change the join separator, for example:

```js
join(
  [sql`first_name LIKE ${firstName}`, sql`last_name LIKE ${lastName}`],
  ' AND ',
); // => "first_name LIKE ? AND last_name LIKE ?"
```

### Raw

Accepts a string and returns a SQL instance, useful if you want some part of the SQL to be dynamic.

```js
raw('SELECT'); // == sql`SELECT`
```

**Do not** accept user input to `raw`, this will create a SQL injection vulnerability.

### Empty

Simple placeholder value for an empty SQL string. Equivalent to `raw("")`.

### Bulk

Accepts an array of arrays, and returns the SQL with the values joined together in a format useful for bulk inserts.

```js
const query = sql`INSERT INTO users (name) VALUES ${bulk([
  ['Blake'],
  ['Bob'],
  ['Joe'],
])}`;

query.sql; //=> "INSERT INTO users (name) VALUES (?),(?),(?)"
query.values; //=> ["Blake", "Bob", "Joe"]
```

## Recipes

This package "just works" with [`pg`](https://www.npmjs.com/package/pg), [`mysql`](https://www.npmjs.com/package/mysql), [`sqlite`](https://www.npmjs.com/package/sqlite) and [`oracledb`](https://www.npmjs.com/package/node-oracledb).

### [MSSQL](https://www.npmjs.com/package/mssql)

```js
mssql.query(query.strings, ...query.values);
```

### Stricter TypeScript

The default value is `unknown` to support [every possible input](https://github.com/blakeembrey/sql-template-tag/pull/26). If you want stricter TypeScript values you can create a new `sql` template tag function.

```ts
import { Sql } from '@ziptie-soft/sql-template-tag';

type SupportedValue =
  | string
  | number
  | SupportedValue[]
  | { [key: string]: SupportedValue };

function sql(
  strings: ReadonlyArray<string>,
  ...values: Array<SupportedValue | Sql>
) {
  return new Sql(strings, values);
}
```

## Related

Some other modules exist that do something similar:

- [`sql-template-strings`](https://github.com/felixfbecker/node-sql-template-strings): promotes mutation via chained methods and lacks nesting SQL statements. The idea to support `sql` and `text` properties for dual `mysql` and `pg` compatibility came from here.
- [`pg-template-tag`](https://github.com/XeCycle/pg-template-tag): missing TypeScript and MySQL support. This is the API I envisioned before writing this library, and by supporting `pg` only it has the ability to [dedupe `values`](https://github.com/XeCycle/pg-template-tag/issues/5#issuecomment-386875336).

## Credits

Originally created by [Blake Embrey](http://blakeembrey.me) as [`sql-template-tag`](https://github.com/blakeembrey/sql-template-tag). Maintained by [Ziptie Soft](https://github.com/ziptie-soft).

## License

MIT

[npm-image]: https://img.shields.io/npm/v/@ziptie-soft/sql-template-tag
[npm-url]: https://npmjs.org/package/@ziptie-soft/sql-template-tag
[downloads-image]: https://img.shields.io/npm/dm/@ziptie-soft/sql-template-tag
[downloads-url]: https://npmjs.org/package/@ziptie-soft/sql-template-tag
[build-image]: https://img.shields.io/github/actions/workflow/status/ziptie-soft/sql-template-tag/verify.yml?branch=master
[build-url]: https://github.com/ziptie-soft/sql-template-tag/actions/workflows/verify.yml?query=branch%3Amaster
[coverage-image]: https://img.shields.io/codecov/c/gh/ziptie-soft/sql-template-tag
[coverage-url]: https://codecov.io/gh/ziptie-soft/sql-template-tag
