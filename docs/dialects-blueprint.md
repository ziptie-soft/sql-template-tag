# Blueprint: Snowflake + Apache Pinot dialects for sql-template-tag

## Context
`src/index.ts` contains `Sql`, which keeps flattened `strings[]` and `values[]`. It has the getters `.sql` (`?`), `.statement` (`:1`), `.text` (`$1`) and `.values`, plus `inspect()`, `join`, `bulk`, `raw`, `empty` and the default `sql` tag. The core is benchmark-tuned (`benchmarks/index.ts`: 1M nested queries).

We want first-class support for:
- **Snowflake**, with bound and inlined output.
- **Apache Pinot**, inlined only, because the broker's `/query/sql` endpoint has no bind parameters.

Two consumers have to be able to migrate with little friction:
- `pinot-noir` (`src/utils/format.ts`, `sql-utils.ts`, `client/broker/broker-client.ts`).
- the analytics Snowflake library (`libs/snowflake`).

Priorities, in order:
1. Modern.
2. Secure: injection-proof by construction.
3. Maintainable and well tested.
4. Fast.

## 1. Research findings

### Snowflake
Sources are the `snowflake-sdk` source (`lib/connection/statement.js` `buildBindsMap`) and the docs.

**Bind syntax**
- `?` and `:1` are both positional. `binds[i]` becomes key `i+1`.
- There are no named binds in the driver.

**Driver type inference**
- boolean → BOOLEAN.
- Plain object or array → VARIANT, via JSON.stringify.
- Integer → FIXED. Other numbers → REAL.
- Everything else → TEXT.
- A Date is sent as `toJSON()`. **An invalid Date silently becomes `null`.**

**Array-binding trap.** If `binds[0]` is an array, the whole call switches to bulk array-binding mode, with types taken from row 0. A single-row query whose first value is a JS array gets misread.

**Unsupported values**
- `bigint` throws, because `JSON.stringify` does in the pre-check.
- `undefined` is rejected.
- NaN or ±Infinity becomes the string `"null"`.
- A Buffer turns into garbage VARIANT JSON.

**Multi-statement.** Binds are not supported in multi-statement requests, so an inlined form is needed there. It's also needed for logging.

**`$1` collision.** `$1` is a stage or positional column reference. `.text` output is silently wrong on Snowflake.

**String literals**
- `'…'` with `''`, **and backslash escapes are processed** (`\'` `\\` `\n` `\0` `\xhh` `\uhhhh`…). An unknown escape such as `\z` becomes `z`.
- An escaper that only doubles `'` is therefore injectable: `\'` comes out as `'\'''`, which Snowflake reads as an escaped quote followed by a string that's still open.
- `$$…$$` strings are literal and cannot contain `$$`.

**Identifiers and comments**
- `"…"` with `""` is case-sensitive. Unquoted names fold to UPPER.
- `IDENTIFIER(?)` binds a name string.
- Comments are `--`, `//` and `/* */`.

### Pinot
Sources are the docs pages "querying-pinot", "sql-reference", "query-options" and the MSE troubleshooting page.

**Lexing**
- Calcite `Lex.MYSQL_ANSI`: `'…'` with `''` and **no backslash escapes**.
- `"…"` identifiers with `""`, case-sensitive.
- Backticks are not identifier quotes.
- Reserved words (`timestamp`, `date`, …) need double quotes.

**Literals**
- There are no binds.
- Decimals should be quoted to keep precision.
- Binary literals are `X'0102'` in both SSE and MSE.
- `ARRAY[…]` literals exist, and IN lists use `(a, b)`.

**Query options**
- Use `SET key = value;` before the query. Several are allowed.
- Strings are quoted; numbers and booleans are bare.
- Keys are case-insensitive.
- The legacy `OPTION(...)` is controlled by `legacySyntaxMode`.
- The REST `queryOptions` field uses `k=v;k2=v2`.

**MSE** (`SET useMultistageEngine = true;`)
- Same lexer and literal syntax.
- Stricter type conformance: `timestampCol >= longCol` needs a CAST.
- Uses SQL-standard CAST type names.
- No default LIMIT 10.

### pinot-noir today
- `formatQuery` has a good lexical guard: a value placed inside a quote or comment throws, and it's ReDoS-safe. **Upstream it.**
- Its literal escaper is mysql `sqlstring`. It turns `\` into `\\`, `\n` into backslash-n and `"` into `""` inside `'…'`. Under Calcite these are **value corruption** (not injection), and its tests encode them.
- It silently turns arrays into lists, objects into `'[object Object]'`, `undefined` into NULL and an invalid Date into NULL. Dates default to local time, and `escapeId` splits on `.`.

### Snowflake consumer library today
- Uses `sql`, `join`, `raw`, `empty`, `Sql`; executes with `con.execute({ sqlText: q.sql, binds: q.values })`. Values include Date, Luxon `DateTime`, arrays, numbers, strings and null.
- Session context uses `SET (A, B) = (?, ?);` with names regex-validated then passed through `raw()`.
- Risk: a logging inliner escapes strings with `'${v.replace(/'/g,"''")}'`, which a backslash breaks out of.
- Risk: identifiers built as `` `"${field}"` `` via `raw()` without escaping `"`; filter fields via `raw(filter.field)` from unvalidated request input, emitted unquoted.
- Risk: `GET_DDL('PROCEDURE', '${raw(db)}.${raw(schema)}…')` puts raw text inside a literal. **The lexer can't catch raw-in-literal**, because raw text merges into `strings`. The fix is to bind it.
- Patterns: `IN (${join(values)})`, `ARRAY_CONSTRUCT(${join(values)})`, LIKE built as `${`%${v}%`}` (wildcards unescaped), `CALL fqn(PARSE_JSON(?))` with `JSON.stringify(payload)` (a `variant()` use case). Only `.sql`/`.values` used. `queryHash` over `.sql` + `.values` is a cache key, so text changes invalidate cache (acceptable; call out). `Number(v)` can put NaN into binds; `bind()` turns that into a thrown error.

### `sql-escaper` (evaluated)
MySQL-only backslash escaping (`'` → `\'`) — under Calcite `'x\' OR 1=1 --'` ends the literal after `x\`, an **injection in Pinot**. Backtick identifiers are wrong for both. In Snowflake `\Z` corrupts 0x1A. Unknown types silently stringified. **Recommendation: don't depend, don't vendor; write our own** (~40 lines per dialect). Borrow ideas only: single-pass charCode escaping loop and its test vectors.

## 2. Architecture
- **`src/index.ts`: unchanged.** All getters keep their exact output, and `Value = unknown` stays. Zero added hot-path cost for non-dialect users.
- **`src/internal/lexer.ts`:** `assertValueBoundaries(strings, cfg)`.
  - A table-driven char-code state machine that walks `strings[]` in place, carrying state across boundaries. No `join`, no regex.
  - Throws if a boundary falls inside a quote or comment context, or if a context is still open at the end.
  - Config flags: `backslashInStrings`, `dollarQuoted`, `slashSlashComment`, `backtick`, `forbidBareQuestionMark`.
- **`src/internal/literals.ts`:**
  - `classify(value)` returns a tagged kind or throws.
  - String quoting (fast path plus single pass), `formatNumber`, `hex(Uint8Array)` through a 256-entry lookup table (or the native `toHex` when present), `quoteIdentifier(parts)`.
  - `assertShape(sql)` structural check: `strings.length === values.length + 1`, all strings are strings, both are real arrays.
  - The token-fusion guard.
- **`src/internal/errors.ts`:** `SqlDialectError extends TypeError` with `{ dialect, index, reason }`.
- **`src/dialects/pinot.ts`** and **`src/dialects/snowflake.ts`:** public surfaces, ~150 lines each, table-driven.
- **`package.json` exports:** add `"./pinot"` and `"./snowflake"`, each with `types`/`import`/`require`. Also `typesVersions` and `sideEffects: false`. No root re-export.
- **Modern:** ES2022, no Node-only APIs (`Uint8Array` instead of `Buffer`; Buffer still works as a subclass), so it runs on Node, Bun, Deno and edge runtimes. Strict TS, typed option objects.
- **Package identity:** the core detects nested fragments with `child instanceof Sql`. Every entry point must share **one `Sql` class identity** (ESM wraps CJS). Otherwise an `identifier()` from ESM `./pinot` nested in a CJS `sql` tag would be treated as a value (fails safe but broken).

## 3. Public API
```ts
// @ziptie-soft/sql-template-tag/pinot
export interface PinotInlineOptions {
  dateStyle?: 'string' | 'epochMillis' | 'timestamp';  // default 'string' (D4)
  coerce?: (value: unknown) => unknown;                 // custom types → supported primitive (e.g. Luxon → ISO)
}
export function inline(query: Sql, options?: PinotInlineOptions): string;
export function identifier(name: string | readonly string[]): Sql;   // "a" / "a"."b"; never splits on '.'
export function bareIdentifier(name: string): Sql;                    // validated /^[A-Za-z_][A-Za-z0-9_]*$/, emitted verbatim
export function array(values: readonly RawValue[]): Sql;              // ARRAY[v1,v2]
export function queryOptions(o: Record<string, string | number | bigint | boolean | undefined>): Sql; // SET k = v;\n…

// @ziptie-soft/sql-template-tag/snowflake
export type SnowflakeBind = string | number | boolean | null;
export interface SnowflakeOptions { coerce?: (value: unknown) => unknown }
export function bind(query: Sql, options?: SnowflakeOptions): { sqlText: string; binds: SnowflakeBind[] | SnowflakeBind[][] }; // spread into connection.execute
export function inline(query: Sql, options?: SnowflakeOptions): string;  // multi-statement + logging
export function identifier(name: string | readonly string[]): Sql;      // "DB"."S"."t" (case-sensitive)
export function bareIdentifier(name: string): Sql;                       // unquoted, validated /^[A-Za-z_][A-Za-z0-9_$]*$/
export function variant(value: unknown): Sql;                            // sql`PARSE_JSON(${JSON.stringify(value)})`
export function rows(data: ReadonlyArray<ReadonlyArray<RawValue>>): RowsBind;  // driver array binding, bind() only
```
Composition rules:
- Every helper returns a plain core `Sql`, composing with `sql`, `join`, `bulk`, `raw`, `empty` and all core getters.
- `identifier` and `bareIdentifier` are text-only fragments, safe by construction.
- `array` and `variant` carry their values through the normal rules.
- `coerce` runs before classification. Its result must be a supported primitive or Date, otherwise it throws. It can never produce raw SQL text.

## 4. Rendering rules

### 4.1 Pipeline (both renderers)
1. Run `assertShape`, then the lexer.
   - A value inside `'…'`, `"…"`, a backtick, `--`, `/* */`, `$$…$$` (sf) or `//` (sf), or any unterminated context, throws.
   - `raw()` text is part of `strings`, so it is lexed too. `${raw("'")}${v}${raw("'")}` throws.
2. **Token-fusion guard (inline only).** Before an inlined literal, insert one space if the previous emitted character matches `[A-Za-z0-9_$&'".-]`. Blocks: `a-${-1}` → `a--1` comment; `${"a'"}${"b'"}` merging; `X${'41'}`, `N…`, `U&…` prefix capture; `$${1}` → `$1`; `t.${5}` → `t.5`. Other text passes through byte-for-byte.
3. Classify and render each value. **Unsupported values throw `SqlDialectError` with the value index. Nothing is ever silently stringified.**

| JS value | Pinot `inline` | Snowflake `bind` (bind; text) | Snowflake `inline` |
|---|---|---|---|
| `null` | `NULL` | `null`; `?` | `NULL` |
| `undefined` | throw (D1) | throw | throw |
| boolean | `TRUE` / `FALSE` | as-is | `TRUE` / `FALSE` |
| finite safe integer or non-integer | `String(n)` (`-0`→`0`) | as-is | `String(n)` |
| NaN, ±Inf, unsafe integer | throw (use bigint) (D2) | throw | throw |
| bigint | digits | `String(b)` | digits |
| string | `'`+`'`→`''`+`'`; NUL throws (D3); `\`, `"` and newlines verbatim | as-is | `'` + `\`→`\\` **then** `'`→`''`, NUL→`\0` + `'` |
| valid Date | `'YYYY-MM-DD HH:mm:ss.SSS'` UTC, or `getTime()`, or `CAST('…' AS TIMESTAMP)` per `dateStyle` | `toISOString()` | `'<toISOString()>'` |
| invalid Date | throw | throw | throw |
| Uint8Array / Buffer | `X'<hex>'` | `TO_BINARY(?, 'HEX')` + hex (D9) | `TO_BINARY('<hex>', 'HEX')` |
| Array | throw → `join()`/`array()` (D5) | throw → `join()`/`variant()`/`rows()` | throw |
| plain object, Map, Set, Temporal, class instance | throw | throw → `variant()` / `coerce` | throw |
| symbol, function | throw | throw | throw |

### 4.2 Pinot specifics
- **`identifier`**: each part non-empty, no NUL; `"` → `""`, wrapped in `"…"`; always quotes (no reserved-word list).
- **`array`**: non-empty; built from `new Sql(['ARRAY[', ',', …, ']'], values)`.
- **`queryOptions`**: keys match `^[A-Za-z_][A-Za-z0-9_]*$`; `undefined` skipped; strings use literal rule; numbers finite; bigint digits; booleans lowercase; else throw; empty object returns `empty`.
- **MSE** needs no separate path. Document `queryOptions({ useMultistageEngine: true })`, strict typing, and `dateStyle:'epochMillis'` for LONG epoch columns.

### 4.3 Snowflake specifics
- **`bind`**: lexer config enables backslash strings, `$$`, `//`, `/* */`. Throws on a **bare `?` in template text** outside quotes. Output uses `?` placeholders, never `$n`. `binds` contains only `string | number | boolean | null`.
- **`rows(data)`**: non-empty, equal-length rows, cells normalized per table. Must be the **only** value in the query, else throw. Renders `(?, …)` once, `binds` as `SnowflakeBind[][]`. Document row-0 type inference and `CLIENT_STAGE_ARRAY_BINDING_THRESHOLD`; `bulk()` stays for small batches.
- **`variant`**: `JSON.stringify` must return a string; bigint inside rethrown with context.
- **`identifier`**: ≤255 chars per part. Document case sensitivity and `IDENTIFIER(${name})`.
- **Not supported:** named binds and `$$` output (D6).
- **`.text`:** document "never use `.text` with Snowflake".

## 5. Performance invariants and benchmarks
1. Core `benchmarks/index.ts` unchanged; time and heap within ±3% of master; core imports nothing from dialects.
2. Dialect modules side-effect free; top level holds only constant tables.
3. One linear pass: lexer reads `charCodeAt`, no `join`, no regex; renderer concatenates one string; `binds` preallocated `new Array(n)`.
4. Escaping fast path: `indexOf("'")` (plus `indexOf("\\")` for sf, plus NUL check); clean string returns `"'" + s + "'"`. Slow path: single charCode loop with chunked `slice`, never per-char regex.
5. No caching on `Sql` (mutable arrays).
6. Helpers do their work once, at fragment build time.

`benchmarks/dialects.ts`: (a) typical query via Pinot `inline` and Snowflake `bind`; (b) escape-heavy strings (10% contain `'` or `\`); (c) `IN` list of 10k via `join`; (d) `bulk` 1k×10 and `rows` 1k×10; (e) lexer over 100 KB template full of strings and comments.
Budgets: (a) ≤ 2× core `.sql` + `.values`; (c) 10k ≤ 10.5× 1k; (e) < 5 ms; 1 MB adversarial input < 50 ms (no ReDoS). Report ops/s and heap; CI non-blocking or ratio check.

## 6. Backwards compatibility
Core exports, types, getter output byte-identical; existing core tests pass unmodified. Additive subpaths only: semver minor, no runtime deps. Dialect code reads only the public `Sql` shape and never mutates input.

## 7. Migration (for README "Migrating" section)
pinot-noir: `SqlFormat.formatQuery(query)` → `inline(query)`; options → `inline(sql`${queryOptions(opts)}${query}`)`; `IN (${['a','b']})` → `IN (${join(['a','b'])})`; `escapeId('schema.col')` → `identifier(['schema','col'])`. Intentional behaviour changes: `\`, control chars and `"` kept verbatim (were corrupted); arrays/objects/undefined/invalid Date throw; Dates UTC; no dot-splitting.
Snowflake: `con.execute({ ...bind(q, { coerce }) })`; logging via `inline(q, { coerce })`; `raw(`"${f}"`)` → `identifier(f)`; unquoted filter fields → `join(f.split('.').map(bareIdentifier), '.')`; raw-in-literal → bind the whole string; `SHOW … IN ${identifier([db, schema, view])}`; `CALL … (${variant(payload)})`; session `SET (${join(names.map(bareIdentifier), ', ')}) = (${join(binds)})`.
**Security-model note:** the lexer guarantees values never land inside quotes or comments. It **cannot** protect against `raw(untrusted)`, including raw text inside a literal. `raw` stays a trusted-input escape hatch; docs point to `identifier`, `bareIdentifier` or binding.

## 8. Test matrix (node:test; `fast-check` devDependency for property tests)
- Scalars per dialect and mode: null, booleans, 0, -0, -1, 1.5, 1e-7, 2^53-1, 2^53 (throws), NaN/±Inf (throw); bigint 0 and min-int64; '', unicode/emoji, newlines; valid/invalid Dates, Uint8Array `[]` and `[0,255]`, Buffer; each `dateStyle`.
- Rejections, each asserting `SqlDialectError` with index: undefined, symbol, function, `{}`, `[]`, `[1]`, Map, Set, `Object.create(null)`, class instance, `JSON.parse('{"a":1}')`, a `coerce` returning an object.
- Injection corpus through `inline`/`bind` × nested `Sql`/`join`/`bulk`/`array`/`queryOptions`/`variant`: `'`, `x' OR 1=1 --`, `'; SELECT 2; /*`, `\'; --`, `\\'`, `back\slash`, `a"b`, `/* ? */ -- ?`, `// x`, `$$`, `$$; DROP TABLE t; $$`, `? ?? :1 $1`, `\0`, `\x1a`, `’`, lone surrogate.
- Round-trip property: a test-only reference tokenizer per dialect decodes every inlined literal back to its input, for arbitrary strings including `\` and `'` runs; Pinot (no backslash) and Snowflake (backslash).
- Context guard: value inside each quote/comment kind, complete and unterminated; `'it\'s ${v}'` (sf); `raw()`-wrapped quotes; bare `?` in sf `bind` text throws, `'?'` fine.
- Token fusion: `a-${-1}`, `${"a'"}${"b'"}`, `X${'41'}`, `N${'x'}`, `U&${'x'}`, `$${1}`, `t.${5}`, re-tokenized to check expected tokens.
- Snowflake bind: first value Date/bigint/bytes; `rows` alone, mixed (throws), ragged (throws), empty (throws); result spreads into `execute`; `identifier`/`bareIdentifier` validation incl. length > 255.
- Structural: mutated `strings`/`values` lengths throw; structurally cloned `Sql` accepted; deterministic output.
- Back-compat: core tests unchanged and green; snapshot of core getters on dialect-helper fragments.
- Consumer contract tests: pinot-noir `sql-security.test.ts`-style scenarios with corrected values; analytics-style fixtures (IN, ARRAY_CONSTRUCT, LIKE, session SET).

## 9. README sections
Dialects overview table (driver vs getter/renderer); Snowflake (bind vs inline, why not `.text`, identifiers/bareIdentifier/IDENTIFIER(), variant, rows, dates, binary, multi-statement, coerce for Luxon/Temporal); Apache Pinot (why inline, literal rules, identifiers/reserved words, join/array for IN, queryOptions + MSE, dateStyle, bytes); Security model (lexical guard, token-fusion guard, unsupported values throw, raw() trusted but lexed); Performance numbers; Migrating from pinot-noir SqlFormat / hand-rolled Snowflake formatters.

## 10. Build slices
1. Errors + literals (`src/internal/errors.ts`, `literals.ts`) — classification, number/bigint/date/hex, fast-path quoter, `quoteIdentifier`, `assertShape`, fusion guard. Every branch formats or throws. Acceptance: scalar + rejection matrices; fast-path microbench.
2. Lexer (`src/internal/lexer.ts`) — linear, fails closed, per-dialect config. Acceptance: context-guard matrix; 1 MB adversarial < 50 ms; 100 KB < 5 ms.
3. Pinot (`src/dialects/pinot.ts`, `./pinot` export) — inline, identifier, bareIdentifier, array, queryOptions, dateStyle, coerce. Acceptance: corpus, round-trip, composition; core bench ±3%.
4. Snowflake bind (`src/dialects/snowflake.ts`, `./snowflake` export) — bind, identifier, bareIdentifier, variant, coerce. Never `$n`; bare `?` throws; primitive binds. Acceptance: bind matrix.
5. Snowflake inline — backslash-aware escaping, `TO_BINARY`. Acceptance: sf round-trip + corpus.
6. Snowflake `rows()` — mixing/ragged/empty rejections.
7. Benchmarks (`benchmarks/dialects.ts`) — §5 budgets met and recorded in README.
8. Packaging + docs — export map, typesVersions, sideEffects, single `Sql` identity, README, (CHANGELOG is semantic-release generated). attw/publint clean for `.`, `./pinot`, `./snowflake`; CJS/ESM smoke incl. `identifier()` from one format nested in `sql` from the other.

## 11. Decisions (accepted)
D1 undefined throws. D2 unsafe ints throw (use bigint). D3 NUL throws in Pinot, `\0` in Snowflake. D4 Pinot Date default UTC `'YYYY-MM-DD HH:mm:ss.SSS'`. D5 raw arrays throw. D6 no named binds, no `$$` output. D7 identity solved in build. D8 no sql-escaper. D9 `TO_BINARY(…, 'HEX')`. D10 `like()` follow-up. D11 `@ziptie-soft/sql-template-tag`.
