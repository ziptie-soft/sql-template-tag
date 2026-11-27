/** Snowflake dialect: driver-ready bind output and safe fragment helpers.
 *
 * `bind` renders a query to `{ sqlText, binds }` for `snowflake-sdk`'s `connection.execute`.
 * Every value becomes a `?` placeholder and a primitive bind (`string | number | boolean |
 * null`), so the driver never has to guess a type from an object, a `Date` or a `bigint`.
 * Unsupported values throw `SqlDialectError`; nothing is ever silently stringified. A value
 * can never land inside a quote or comment, and `raw()` stays a trusted-input escape hatch.
 *
 * `inline` renders the same query with every value as a literal, for multi-statement requests
 * and logging.
 *
 * Never use the core `.text` getter with Snowflake: its `$1` is a stage or column reference.
 *
 * @packageDocumentation
 */

import { raw, Sql } from '../index.js';
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

/** Render a query for `snowflake-sdk`: `?` placeholders in `sqlText`, primitives in `binds`.
 *
 * `bigint` binds as decimal digits, a `Date` as ISO-8601 UTC text, and a `Uint8Array` as hex
 * behind `TO_BINARY(?, 'HEX')`. Numbers must be finite safe integers or non-integers (use
 * `bigint` for larger ones). Arrays, objects, `undefined`, symbols and functions throw; use
 * `join()`, {@link variant} or `coerce` for those. A bare `?` in the template text throws,
 * as does a value inside a quote or comment. Throws {@link SqlDialectError}; the input is
 * never mutated.
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
  // oxlint-disable-next-line unicorn/no-new-array -- preallocated, filled in the loop below
  const binds = new Array<SnowflakeBind>(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = applyCoerce(coerce, values[i]);
    const kind = classify(value, 'snowflake', i);
    binds[i] = toBind(value, kind);
    sqlText +=
      (kind === Kind.BYTES ? BYTES_PLACEHOLDER : '?') +
      (strings[i + 1] as string);
  }

  return { sqlText, binds };
}

const renderLiteral = literalRenderer('snowflake', {
  string: quoteSnowflakeString,
  date: (value) => "'" + formatDateIso(value) + "'",
  bytes: (value) => "TO_BINARY('" + hex(value) + "', 'HEX')",
});

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
