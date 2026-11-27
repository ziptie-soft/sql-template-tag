/** Snowflake dialect: driver-ready bind output and safe fragment helpers.
 *
 * `bind` renders a query to `{ sqlText, binds }` for `snowflake-sdk`'s `connection.execute`.
 * Every value becomes a `?` placeholder and a primitive bind (`string | number | boolean |
 * null`), so the driver never has to guess a type from an object, a `Date` or a `bigint`.
 * Unsupported values throw `SqlDialectError`; nothing is ever silently stringified. A value
 * can never land inside a quote or comment, and `raw()` stays a trusted-input escape hatch.
 *
 * `inline` renders the same query with every value as a literal, for multi-statement requests
 * and logging. `rows` builds a multi-row fragment for the driver's array binding (`bind` only).
 *
 * Never use the core `.text` getter with Snowflake: its `$1` is a stage or column reference.
 *
 * @packageDocumentation
 */

import { raw, Sql, type RawValue } from '../index.js';
import { SqlDialectError } from '../internal/errors.js';
import {
  SNOWFLAKE_BIND_LEXER,
  SNOWFLAKE_INLINE_LEXER,
} from '../internal/lexer.js';
import {
  assertBareIdentifier,
  classify,
  formatBigint,
  formatDateIso,
  hex,
  Kind,
  quoteIdentifier,
  quoteSnowflakeString,
} from '../internal/literals.js';
import {
  applyCoerce,
  checkQuery,
  fail as renderFail,
  literalRenderer,
  readCoerce,
  renderInline,
} from '../internal/render.js';

export { SqlDialectError } from '../internal/errors.js';

/** A value the Snowflake driver binds without type guessing.
 *
 * @public
 */
export type SnowflakeBind = string | number | boolean | null;

/** Options for {@link bind}.
 *
 * @public
 */
export interface SnowflakeOptions {
  /** Maps custom types (Luxon, Temporal, …) to a supported value before binding. Its result
   * is classified like any other value, so it can never produce raw SQL text. */
  readonly coerce?: (value: unknown) => unknown;
}

/** The statement options produced by {@link bind}; spread them into `connection.execute`:
 * `connection.execute({ ...bind(query), complete })`.
 *
 * @public
 */
export interface SnowflakeStatement {
  sqlText: string;
  binds: SnowflakeBind[] | SnowflakeBind[][];
}

// Identifiers are at most 255 characters (UTF-16 code units here).
const MAX_IDENTIFIER_LENGTH = 255;
const BARE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;
const BYTES_PLACEHOLDER = "TO_BINARY(?, 'HEX')";

function fail(reason: string): never {
  return renderFail('snowflake', reason);
}

function toBind(value: unknown, kind: Kind): SnowflakeBind {
  switch (kind) {
    case Kind.NULL:
      return null;
    case Kind.BIGINT:
      return formatBigint(value as bigint);
    case Kind.DATE:
      return formatDateIso(value as Date);
    case Kind.BYTES:
      return hex(value as Uint8Array);
    default:
      // BOOLEAN, NUMBER and STRING are already primitive binds.
      return value as SnowflakeBind;
  }
}

type RowData = readonly (readonly unknown[])[];

/** Marker carried by the single value of a {@link rows} fragment. It holds a frozen copy of
 * the validated rows in a private field, so the brand check in `rowsOf` cannot be satisfied
 * by `Object.create(marker)`, a Proxy or a look-alike object.
 */
class RowsBind {
  readonly #rows: RowData;

  constructor(data: RowData) {
    this.#rows = Object.freeze(data);
    Object.freeze(this);
  }

  /** The rows of a genuine marker, or `undefined` for any other value. */
  static rowsOf(value: unknown): RowData | undefined {
    return typeof value === 'object' && value !== null && #rows in value
      ? value.#rows
      : undefined;
  }
}

function allocate<T>(length: number): T[] {
  // oxlint-disable-next-line unicorn/no-new-array -- preallocated, filled by the caller
  return new Array<T>(length);
}

/** Record whether a column holds bytes; `null` fits either, a mix of the two kinds throws. */
function markColumn(
  bytes: (boolean | undefined)[],
  column: number,
  kind: Kind,
  index: number,
): void {
  if (kind === Kind.NULL) {
    return;
  }

  const isBytes = kind === Kind.BYTES;
  if (bytes[column] === undefined) {
    bytes[column] = isBytes;
  } else if (bytes[column] !== isBytes) {
    throw new SqlDialectError(
      'snowflake',
      `rows(): column ${column} mixes bytes and non-bytes values`,
      index,
    );
  }
}

function bindRows(
  source: RowData,
  strings: readonly string[],
  count: number,
  index: number,
  coerce: ((value: unknown) => unknown) | undefined,
): SnowflakeStatement {
  if (count !== 1) {
    throw new SqlDialectError(
      'snowflake',
      'rows() must be the only value in the query',
      index,
    );
  }

  const width = (source[0] as readonly unknown[]).length;
  const binds = allocate<SnowflakeBind[]>(source.length);
  const bytes: (boolean | undefined)[] = [];
  for (let r = 0; r < source.length; r++) {
    const cells = source[r] as readonly unknown[];
    const row = allocate<SnowflakeBind>(width);
    for (let c = 0; c < width; c++) {
      // The cell's flat position, reported as the error's value index.
      const flat = r * width + c;
      const value = applyCoerce(coerce, cells[c]);
      const kind = classify(value, 'snowflake', flat);
      row[c] = toBind(value, kind);
      markColumn(bytes, c, kind, flat);
    }

    binds[r] = row;
  }

  let placeholders = bytes[0] === true ? BYTES_PLACEHOLDER : '?';
  for (let c = 1; c < width; c++) {
    placeholders += ', ' + (bytes[c] === true ? BYTES_PLACEHOLDER : '?');
  }

  return {
    sqlText: (strings[0] as string) + placeholders + (strings[1] as string),
    binds,
  };
}

/** Render a query for `snowflake-sdk`: `?` placeholders in `sqlText`, primitives in `binds`.
 *
 * `bigint` binds as decimal digits, a `Date` as ISO-8601 UTC text, and a `Uint8Array` as hex
 * behind `TO_BINARY(?, 'HEX')`. Numbers must be finite safe integers or non-integers (use
 * `bigint` for larger ones). Arrays, objects, `undefined`, symbols and functions throw; use
 * `join()`, {@link variant} or `coerce` for those. A bare `?` in the template text throws,
 * as does a value inside a quote or comment. Throws {@link SqlDialectError}; the input is
 * never mutated.
 *
 * `binds` is a flat `SnowflakeBind[]`, except when the query holds a {@link rows} fragment:
 * then that is the query's only value and `binds` is a `SnowflakeBind[][]`, one array per row,
 * which makes the driver use array binding.
 *
 * @public
 */
export function bind(
  query: Sql,
  options?: SnowflakeOptions,
): SnowflakeStatement {
  const coerce = readCoerce(options, 'snowflake');
  checkQuery(query, SNOWFLAKE_BIND_LEXER);
  const { strings, values } = query;

  let sqlText = strings[0] as string;
  const binds = allocate<SnowflakeBind>(values.length);
  for (let i = 0; i < values.length; i++) {
    // Checked before `coerce`, which must never see (or replace) the private marker.
    const marked = RowsBind.rowsOf(values[i]);
    if (marked !== undefined) {
      return bindRows(marked, strings, values.length, i, coerce);
    }

    const value = applyCoerce(coerce, values[i]);
    const kind = classify(value, 'snowflake', i);
    binds[i] = toBind(value, kind);
    sqlText +=
      (kind === Kind.BYTES ? BYTES_PLACEHOLDER : '?') +
      (strings[i + 1] as string);
  }

  return { sqlText, binds };
}

const renderScalar = literalRenderer('snowflake', {
  string: quoteSnowflakeString,
  date: (value) => "'" + formatDateIso(value) + "'",
  bytes: (value) => "TO_BINARY('" + hex(value) + "', 'HEX')",
});

function renderLiteral(value: unknown, index: number): string {
  if (RowsBind.rowsOf(value) !== undefined) {
    throw new SqlDialectError(
      'snowflake',
      'rows() only works with bind(), not inline()',
      index,
    );
  }

  return renderScalar(value, index);
}

/** Render a query to a Snowflake SQL string with every value inlined as a literal.
 *
 * For multi-statement requests (the driver does not support binds there) and for logging;
 * prefer {@link bind} for single statements. Strings are single-quoted with `\` → `\\`,
 * `'` → `''` and NUL → `\0`, because Snowflake processes backslash escapes. A `Date` renders
 * as an ISO-8601 UTC string and a `Uint8Array` as `TO_BINARY('<hex>', 'HEX')`. Numbers must be
 * finite safe integers or non-integers (use `bigint` for larger ones). A space is inserted
 * where a literal would otherwise fuse with adjacent text (`a-${-1}`, `X${'41'}`). A bare `?`
 * in the template text is kept as is. Throws {@link SqlDialectError} for unsupported values,
 * values inside quotes or comments, or a malformed query. The input is never mutated.
 *
 * @public
 */
export function inline(query: Sql, options?: SnowflakeOptions): string {
  const coerce = readCoerce(options, 'snowflake');
  checkQuery(query, SNOWFLAKE_INLINE_LEXER);
  return renderInline(query, coerce, renderLiteral);
}

/** A double-quoted, case-sensitive identifier: `"A"` or, for a list, `"DB"."S"."T"`.
 *
 * Never splits on `.`; `"` is doubled. Parts must be non-empty, free of NUL and at most 255
 * characters. Unquoted names fold to upper case in Snowflake, so `identifier('t')` does not
 * match a table created as `t`; to bind a name use `IDENTIFIER(${name})` instead.
 *
 * @public
 */
export function identifier(name: string | readonly string[]): Sql {
  return raw(quoteIdentifier(name, 'snowflake', MAX_IDENTIFIER_LENGTH));
}

/** An unquoted identifier matching `/^[A-Za-z_][A-Za-z0-9_$]*$/` (at most 255 characters),
 * emitted verbatim. Snowflake folds it to upper case.
 *
 * @public
 */
export function bareIdentifier(name: string): Sql {
  return raw(assertBareIdentifier(name, BARE_IDENTIFIER_PATTERN, 'snowflake'));
}

/** `PARSE_JSON(?)` bound to `JSON.stringify(value)`, for VARIANT, OBJECT and ARRAY values.
 *
 * Honours `toJSON`. Throws {@link SqlDialectError} when the value cannot be serialised
 * (`bigint` inside, cycles) or has no JSON form (`undefined`, functions, symbols).
 *
 * @public
 */
export function variant(value: unknown): Sql {
  let json: string | undefined;
  try {
    json = JSON.stringify(value) as string | undefined;
  } catch (error) {
    throw new SqlDialectError(
      'snowflake',
      `variant(): ${error instanceof Error ? error.message : 'value is not serialisable'}`,
      undefined,
      { cause: error },
    );
  }

  if (typeof json !== 'string') {
    return fail('variant(): value has no JSON representation');
  }

  return new Sql(['PARSE_JSON(', ')'], [json]);
}

function copyRow(
  row: unknown,
  index: number,
  width: number | undefined,
): readonly unknown[] {
  if (!Array.isArray(row) || row.length === 0) {
    return fail(`rows(): row ${index} must be a non-empty array`);
  }

  if (width !== undefined && row.length !== width) {
    return fail(
      `rows(): row ${index} has ${row.length} cells, expected ${width}`,
    );
  }

  // Each cell is read exactly once, so a hostile array (Proxy, getters) cannot change later.
  const copy: unknown[] = [];
  for (let c = 0; c < row.length; c++) {
    const cell: unknown = row[c];
    if (cell instanceof Sql) {
      return fail(`rows(): cell [${index}][${c}] must not be a Sql fragment`);
    }

    copy.push(cell);
  }

  return Object.freeze(copy);
}

/** A `(?, ?, …)` row template for driver array binding: many rows in one `execute` call.
 *
 * `sql\`INSERT INTO t (a, b) VALUES ${rows(data)}\`` renders `INSERT INTO t (a, b) VALUES (?, ?)`
 * with `binds` as a `SnowflakeBind[][]`, one array per row. It works with {@link bind} only
 * and must be the only value of its query: {@link inline} and the other core getters (`.sql`,
 * `.values`) are not meaningful for it. The placeholder text is the parentheses plus one `?`
 * per column (`TO_BINARY(?, 'HEX')` for a bytes column), so write `VALUES ${rows(data)}`
 * without extra parentheses.
 *
 * `rows()` checks the shape eagerly (a non-empty array of equally long, non-empty rows with no
 * `Sql` cells) and copies the arrays, so later changes to `data` have no effect; cell objects
 * such as `Date`s are not cloned. Cells follow the normal {@link bind} rules, `coerce`
 * included, when the query is bound; an error's `index` is the cell's flat position
 * (`row * columns + column`). A column must not mix bytes and non-bytes values (`null` fits
 * both).
 *
 * The Snowflake driver infers every column's type from the first row only, so give row 0 a
 * representative value in each column (a `null` there can give the column the wrong type).
 * Beyond the session parameter `CLIENT_STAGE_ARRAY_BINDING_THRESHOLD` (see Snowflake's
 * documentation for its default) the driver uploads the rows through a stage instead of
 * sending them inline, which needs a stage and suits large batches. For small batches `bulk()` (`VALUES (?, ?), (?, ?)`) is simpler.
 *
 * @public
 */
export function rows(data: ReadonlyArray<ReadonlyArray<RawValue>>): Sql {
  if (!Array.isArray(data) || data.length === 0) {
    return fail('rows() requires a non-empty array of rows');
  }

  const copy: (readonly unknown[])[] = [];
  let width: number | undefined;
  for (let r = 0; r < data.length; r++) {
    const row = copyRow(data[r], r, width);
    width = row.length;
    copy.push(row);
  }

  return new Sql(['(', ')'], [new RowsBind(copy)]);
}
