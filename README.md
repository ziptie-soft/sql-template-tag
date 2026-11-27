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

## Dialects

The core `sql` tag only collects template strings and values; each driver picks the getter that matches its placeholder style. Two additive subpath exports render a query for engines where that is not enough. They have no runtime dependencies, work in both ESM and CommonJS, and share the one core `Sql` class, so their fragments nest in `sql` from either format.

| Target                                        | Use                                | Output                                                         |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `pg`                                          | `query.text` + `query.values`      | `$1` placeholders                                              |
| `mysql`, `sqlite`                             | `query.sql` + `query.values`       | `?` placeholders                                               |
| `oracledb`                                    | `query.statement` + `query.values` | `:1` placeholders                                              |
| Snowflake (`snowflake-sdk`)                   | `bind(query)` from `/snowflake`    | `{ sqlText, binds }` with `?` placeholders and primitive binds |
| Snowflake (multi-statement requests, logging) | `inline(query)` from `/snowflake`  | One SQL string with every value inlined as a literal           |
| Apache Pinot (broker SQL endpoint)            | `inline(query)` from `/pinot`      | One SQL string with every value inlined as a literal           |

Both renderers are strict: a value they cannot represent exactly throws a `SqlDialectError` instead of being stringified (see [Security model](#security-model)). Helpers such as `identifier`, `variant` and `array` return plain core `Sql` fragments, so they compose with `sql`, `join`, `bulk`, `raw` and `empty`.

### Snowflake

```js
import sql, { join } from '@ziptie-soft/sql-template-tag';
import {
  bind,
  identifier,
  inline,
} from '@ziptie-soft/sql-template-tag/snowflake';

const query = sql`SELECT * FROM ${identifier(['DB', 'S', 'orders'])} WHERE id IN (${join(ids)})`;

// Spread the statement options into `connection.execute`.
connection.execute({ ...bind(query), complete });
```

#### `bind` or `inline`

`bind(query)` returns `{ sqlText, binds }`: every value becomes a `?` placeholder and a primitive bind (`string | number | boolean | null`), so the driver never has to guess a type from an object, a `Date` or a `bigint`. Prefer it for single statements.

`inline(query)` renders every value as a literal in one string. Use it for multi-statement requests (where the driver does not accept binds) and for logging. Strings are single-quoted with `\` → `\\`, `'` → `''` and NUL → `\0`, because Snowflake processes backslash escapes inside string literals.

```js
bind(sql`SELECT ${1}, ${'x'}`); //=> { sqlText: "SELECT ?, ?", binds: [1, "x"] }
inline(sql`SELECT ${"it's"}, ${'a\\b'}`); //=> "SELECT 'it''s', 'a\\\\b'"
```

A bare `?` in the template text makes `bind` throw (it would be mistaken for a placeholder); `'?'` inside a string literal is fine, and `inline` allows both.

#### Never use `.text` with Snowflake

The core `text` getter produces `$1`, `$2`, … In Snowflake `$1` is a positional column or staged-file reference (`SELECT $1 FROM @stage`), not a bind. Always render through `bind` or `inline`.

#### Identifiers

```js
import {
  bareIdentifier,
  identifier,
} from '@ziptie-soft/sql-template-tag/snowflake';

sql`SELECT * FROM ${identifier(['DB', 'S', 't'])}`; // "DB"."S"."t"
sql`SELECT ${bareIdentifier('col')} FROM t`; // unquoted, so Snowflake folds it to upper case
const name = 'MY_DB.MY_SCHEMA.T';
sql`SELECT * FROM IDENTIFIER(${name})`; // bind() sends the name as a bound value
```

- `identifier(name | names)` double-quotes each part (a literal `"` is doubled). It is case-sensitive and never splits on `.`. Unquoted names fold to upper case in Snowflake, so `identifier('t')` does not match a table created as `t`. Parts must be non-empty, free of NUL and at most 255 characters.
- `bareIdentifier(name)` emits the name unquoted after validating `/^[A-Za-z_][A-Za-z0-9_$]*$/` (at most 255 characters).
- `IDENTIFIER(${name})` binds the name as a value; use it when the name comes from a variable and should resolve like an unquoted one.

#### Variants

`variant(value)` is `PARSE_JSON(?)` bound to `JSON.stringify(value)`, for `VARIANT`, `OBJECT` and `ARRAY` columns. It honours `toJSON` and throws when the value has no JSON form (`undefined`, functions, symbols, `bigint` inside, cycles).

```js
bind(sql`CALL load(${variant({ ids: [1, 2] })})`);
//=> { sqlText: "CALL load(PARSE_JSON(?))", binds: ['{"ids":[1,2]}'] }
```

#### Many rows: `rows` and `bulk`

`rows(data)` builds a `(?, ?, …)` row template for the driver's array binding: many rows in one `execute` call. It works with `bind` only, and must be the only value of its query.

```js
import { bind, rows } from '@ziptie-soft/sql-template-tag/snowflake';

bind(
  sql`INSERT INTO t (a, b) VALUES ${rows([
    [1, 'x'],
    [2, 'y'],
  ])}`,
);
//=> { sqlText: "INSERT INTO t (a, b) VALUES (?, ?)", binds: [[1, "x"], [2, "y"]] }
```

- Rows must be non-empty, equally long arrays without `Sql` cells; a ragged or empty shape, or a column that mixes bytes and non-bytes values, throws.
- The driver infers every column's type from the first row only, so give row 0 a representative value in each column (a `null` there can give the column the wrong type).
- Depending on the session parameter `CLIENT_STAGE_ARRAY_BINDING_THRESHOLD`, the driver may upload large batches through a temporary stage instead of sending them inline. Check that parameter and your driver version's documentation before relying on either behaviour.
- For small batches the core `bulk()` is simpler: `VALUES (?,?),(?,?)` with a flat `binds` array.

#### Dates, binary and `coerce`

- A `Date` binds as an ISO-8601 UTC string (`'2024-01-02T03:04:05.678Z'`) and inlines as the same quoted text. An invalid date, or a year outside 0–9999, throws. Cast where the context does not imply a type, for example `CAST(${date} AS TIMESTAMP_TZ)`.
- A `Uint8Array` (or `Buffer`) binds as hex text behind `TO_BINARY(?, 'HEX')` and inlines as `TO_BINARY('…', 'HEX')`.
- A `bigint` binds as decimal digits; numbers must be finite and, if integers, safe (use `bigint` otherwise).
- Arrays, objects, `undefined`, symbols and functions throw. Use `join()`, `variant()` or `coerce`.

`coerce` maps custom types to a supported value before classification. Its result is classified like any other value, so it can never inject SQL text, and it must return a supported primitive or `Date`.

```js
import { DateTime } from 'luxon';

const coerce = (value) =>
  DateTime.isDateTime(value) ? value.toUTC().toISO() : value;

connection.execute({
  ...bind(sql`SELECT * FROM t WHERE created > ${DateTime.now()}`, { coerce }),
  complete,
});

// Temporal works the same way.
const coerceTemporal = (value) =>
  value instanceof Temporal.Instant ? value.toString() : value;
```

### Apache Pinot

```js
import sql, { join } from '@ziptie-soft/sql-template-tag';
import { inline } from '@ziptie-soft/sql-template-tag/pinot';

const query = sql`SELECT * FROM events WHERE city = ${"O'Hare"} AND n IN (${join([1, 2, 3])})`;

inline(query); //=> "SELECT * FROM events WHERE city = 'O''Hare' AND n IN (1,2,3)"
```

#### Why inline

Pinot's broker SQL endpoint has no bind parameters, so `inline(query)` renders every value into the query text, following Calcite's rules. Unlike string concatenation, each value is classified and escaped, a value can never land inside a quote or comment, and unsupported values throw.

#### Literal rules

- Strings are single-quoted, and only `'` is escaped (as `''`). Backslashes, `"` and newlines stay verbatim: `'a\b "q"'` is `'a\b "q"'`. A NUL character throws.
- Numbers must be finite and, if integers, safe (use `bigint` for larger ones); `bigint` renders as decimal digits. `NaN` and `±Infinity` throw.
- `null` → `NULL`, booleans → `TRUE`/`FALSE`.
- `Uint8Array` / `Buffer` → `X'00ff'`.
- `undefined`, arrays, plain objects, symbols, functions and invalid dates throw; there is no implicit stringification. Use `join()`, `array()` or `coerce`.
- A space is inserted where a literal would otherwise fuse with adjacent text (`a-${-1}` renders `a- -1`).

#### Identifiers and reserved words

```js
import {
  bareIdentifier,
  identifier,
} from '@ziptie-soft/sql-template-tag/pinot';

inline(
  sql`SELECT ${identifier('timestamp')} FROM ${identifier(['db', 'my.table'])}`,
);
//=> 'SELECT "timestamp" FROM "db"."my.table"'
inline(sql`SELECT ${bareIdentifier('city')} FROM t`); //=> "SELECT city FROM t"
```

`identifier` always double-quotes (`"` is doubled), never splits on `.`, and is the right choice for reserved words such as `timestamp` or `date`. `bareIdentifier` emits the name verbatim after validating `/^[A-Za-z_][A-Za-z0-9_]*$/`, so it does not help with reserved words.

#### `IN` lists and arrays

```js
import { array, inline } from '@ziptie-soft/sql-template-tag/pinot';

inline(sql`WHERE id IN (${join(ids)})`); // IN (1,2,3)
inline(sql`SELECT ${array(['a', 'b'])} AS tags`); //=> "SELECT ARRAY['a','b'] AS tags"
```

A raw JavaScript array as a value throws: use `join()` for `IN (…)` and `array()` for an `ARRAY[…]` literal whose elements follow the normal value rules.

#### Query options and the multi-stage engine

`queryOptions` renders `SET key = value;` lines to put in front of the query. Strings are quoted, numbers and `bigint`s are bare, booleans are lowercase, `undefined` values are skipped, and it returns `empty` when no option is left. Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.

```js
import { inline, queryOptions } from '@ziptie-soft/sql-template-tag/pinot';

inline(
  sql`${queryOptions({ useMultistageEngine: true, timeoutMs: 5000 })}SELECT 1`,
);
//=> "SET useMultistageEngine = true;\nSET timeoutMs = 5000;\nSELECT 1"
```

#### Dates: `dateStyle`

```js
const date = new Date('2024-01-02T03:04:05.678Z');

inline(sql`WHERE ts > ${date}`); //=> "WHERE ts > '2024-01-02 03:04:05.678'" (UTC)
inline(sql`WHERE ts > ${date}`, { dateStyle: 'epochMillis' }); //=> "WHERE ts > 1704164645678"
inline(sql`WHERE ts > ${date}`, { dateStyle: 'timestamp' });
//=> "WHERE ts > CAST('2024-01-02 03:04:05.678' AS TIMESTAMP)"
```

- `'string'` (default): a UTC `'YYYY-MM-DD HH:mm:ss.SSS'` string.
- `'epochMillis'`: the epoch milliseconds, for `LONG` time columns.
- `'timestamp'`: `CAST('…' AS TIMESTAMP)`.

`inline(query, { coerce })` maps custom types (Luxon, Temporal, …) to a supported value first, exactly as for Snowflake.

## Security model

Both dialects share one set of guarantees:

- **Lexical context guard.** Before rendering, the template text is scanned once, in linear time, for string literals, quoted identifiers, backtick identifiers, comments (`--`, `/* */` with nesting and, for Snowflake, `//`) and Snowflake `$$…$$` strings. A value that sits inside any of them throws, as does a context left open at the end (a trailing line comment is allowed). `'it\'s ${v}'` is caught in Snowflake, where `\'` does not close the string.
- **Token-fusion guard.** An inlined literal never merges with the text around it into a different token: a space is inserted when needed (`a-${-1}`, `X${'41'}`).
- **Unsupported values throw.** `undefined`, arrays, plain objects, symbols, functions, `NaN`/`Infinity`, unsafe integers and invalid dates throw `SqlDialectError`, a `TypeError` subclass with `dialect`, `reason` and `index` (the position of the offending value; `undefined` for a template-level error). Nothing is silently stringified, and a `coerce` result goes through the same checks.
- **Intrinsic-based reads.** `Date` and `Uint8Array` values are read through intrinsics captured at load time, so they work across realms (`vm`, jest) and cannot be spoofed with `Symbol.toStringTag`, an overridden `toISOString` or a look-alike object.
- **Inputs are never mutated.** Only the public `Sql` shape (`strings`, `values`) is read; a malformed or structurally cloned query is validated first.

`raw()` stays a trusted-input escape hatch. Its text is part of the template, so it is lexed too (`${raw("'")}${value}${raw("'")}` is rejected), but the lexer cannot tell whether raw text is itself malicious. It **cannot** protect against `raw(untrusted)`, including untrusted text inside a literal. Use `identifier`, `bareIdentifier` or a bound value instead.

## Performance

Run the dialect benchmarks with `pnpm run benchmark:dialects`; add `-- --check` to exit with code 1 when a budget fails (the default exit code is always 0). For a garbage collection before each run, use `node --expose-gc --import tsx benchmarks/dialects.ts`. The core `pnpm run benchmark` is unchanged and the core entry imports nothing from the dialects.

Numbers from one run on Node.js 26.13.0 (the version pinned in `.mise.toml`; median of 7 runs per case). They depend on the machine and Node.js version, so compare ratios rather than absolutes. The typical-query row is from the latest run; the other rows come from an earlier run on the same machine.

| Scenario                                                       | Pinot `inline`  | Snowflake `bind` | Snowflake `inline` |
| -------------------------------------------------------------- | --------------- | ---------------- | ------------------ |
| Typical query, 9 values (build + render; core baseline 426 ns) | 1.38 µs (3.25×) | 1.17 µs (2.76×)  | 1.34 µs (3.15×)    |
| 1,000 strings, 10% with `'` or `\` (render only)               | 33 µs           | n/a              | 40 µs              |
| `IN` list via `join`, 1k values (build + render)               | 57 µs           | 50 µs            | n/a                |
| `IN` list via `join`, 10k values (build + render)              | 559 µs          | 469 µs           | n/a                |
| `bulk` 1k×10 (build + render)                                  | 1.05 ms         | 661 µs           | n/a                |
| `rows` 1k×10 (build + render)                                  | n/a             | 444 µs           | n/a                |

- **Cost against the core getters.** On a typical 9-value query (a string, a number, a `Date`, a nested `sql` and an `IN` of 5), dialect rendering costs about 3× the bare core `.sql` + `.values` (budget: at most 4×; both sides include building the `Sql`). The core getters only join template strings, whereas a dialect also lexes the whole template to guard every value position and validates each value through intrinsics before formatting it, so a ratio near 2× is not reachable. In absolute terms that is roughly 1 to 1.4 µs per query.
- **Scaling is linear.** The 10k `IN` list costs 9.77× (Pinot `inline`) and 9.47× (Snowflake `bind`) the 1k one (budget: at most 10.5×).
- **Lexer.** A 100 KB template with about 1,000 value positions lexes in about 0.23 ms (budget: under 5 ms), and 1 MB adversarial inputs (runs of `''''`, `/*/*`, `$$$$`, backslashes, `----`) in 1.3 to 7.3 ms (budget: under 50 ms), with no backtracking.
- All budgets passed in this run; `pnpm run benchmark:dialects -- --check` prints the full PASS/FAIL summary.
- Escaping adds little: clean strings render at 32–38 ns each, escape-heavy ones at 33–40 ns.

## Migrating

### From `pinot-noir` `SqlFormat.formatQuery`

| Before                          | After                                          |
| ------------------------------- | ---------------------------------------------- |
| `SqlFormat.formatQuery(query)`  | `inline(query)`                                |
| query options passed as options | ``inline(sql`${queryOptions(opts)}${query}`)`` |
| `IN (${['a', 'b']})`            | `IN (${join(['a', 'b'])})`                     |
| `escapeId('schema.col')`        | `identifier(['schema', 'col'])`                |

Intentional behaviour changes:

- Backslashes, control characters and `"` are now kept verbatim; they were corrupted before.
- Arrays, plain objects, `undefined` and invalid dates throw `SqlDialectError` instead of being coerced.
- `Date` values render in UTC (`'YYYY-MM-DD HH:mm:ss.SSS'`, see `dateStyle`).
- `identifier` never splits on `.`: pass the parts as an array.

**Hashes and cache keys.** If you hash the rendered SQL (a query hash, a result-cache key), it changes for every query whose output differs from the old formatter's: strings with backslashes, control characters or `"`, dates, and re-quoted identifiers. Expect a one-time cache miss after migrating, and derive the key from `inline(query)` output rather than reusing old keys.

### From hand-rolled Snowflake formatters

- `con.execute({ sqlText, binds })` → `con.execute({ ...bind(query, { coerce }) })`; log with `inline(query, { coerce })`.
- ``raw(`"${f}"`)`` → `identifier(f)`.
- An unquoted, dotted filter field → `join(f.split('.').map(bareIdentifier), '.')`.
- A value spliced into a literal with `raw` (`'%${v}%'`) → bind the whole string (``${`%${v}%`}``).
- `SHOW … IN ${identifier([db, schema, view])}`.
- `CALL … (${variant(payload)})`.
- Session `SET (${join(names.map(bareIdentifier), ', ')}) = (${join(binds)})`.

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
