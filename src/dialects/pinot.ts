/** Apache Pinot dialect: inlined literals and safe fragment helpers.
 *
 * Pinot's broker has no bind parameters, so `inline` renders every value into the query text
 * following Calcite's rules (`'…'` strings with `''` and no backslash escapes). Unsupported
 * values throw `SqlDialectError`; nothing is ever silently stringified. A value can never land
 * inside a quote or comment, and `raw()` stays a trusted-input escape hatch.
 *
 * @packageDocumentation
 */

import { empty, raw, Sql, type RawValue } from '../index.js';
import { PINOT_LEXER } from '../internal/lexer.js';
import {
  assertBareIdentifier,
  classify,
  dateMillis,
  formatBigint,
  formatDateUtc,
  formatNumber,
  hex,
  Kind,
  needsSpaceAfter,
  needsSpaceBefore,
  quoteIdentifier,
  quotePinotString,
} from '../internal/literals.js';
import {
  applyCoerce,
  checkQuery,
  fail as renderFail,
  readCoerce,
  type Coerce,
} from '../internal/render.js';

export { SqlDialectError } from '../internal/errors.js';

/** Options for {@link inline}.
 *
 * @public
 */
export interface PinotInlineOptions {
  /** How `Date` values render: a UTC `'YYYY-MM-DD HH:mm:ss.SSS'` string (default), epoch
   * milliseconds, or `CAST('…' AS TIMESTAMP)`. */
  readonly dateStyle?: 'string' | 'epochMillis' | 'timestamp';
  /** Maps custom types (Luxon, Temporal, …) to a supported value before rendering. Its
   * result is classified like any other value, so it can never produce raw SQL text. */
  readonly coerce?: (value: unknown) => unknown;
}

type DateStyle = NonNullable<PinotInlineOptions['dateStyle']>;

const DATE_STYLES: readonly unknown[] = ['string', 'epochMillis', 'timestamp'];
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(reason: string): never {
  return renderFail('pinot', reason);
}

function renderDate(value: Date, style: DateStyle): string {
  if (style === 'epochMillis') {
    return String(dateMillis(value));
  }

  const text = "'" + formatDateUtc(value) + "'";
  return style === 'timestamp' ? 'CAST(' + text + ' AS TIMESTAMP)' : text;
}

function renderLiteral(
  value: unknown,
  style: DateStyle,
  index: number,
): string {
  switch (classify(value, 'pinot', index)) {
    case Kind.NULL:
      return 'NULL';
    case Kind.BOOLEAN:
      return value === true ? 'TRUE' : 'FALSE';
    case Kind.NUMBER:
      return formatNumber(value as number);
    case Kind.BIGINT:
      return formatBigint(value as bigint);
    case Kind.STRING:
      return quotePinotString(value as string, index);
    case Kind.DATE:
      return renderDate(value as Date, style);
    default:
      return "X'" + hex(value as Uint8Array) + "'";
  }
}

function readOptions(options: PinotInlineOptions | undefined): {
  dateStyle: DateStyle;
  coerce: Coerce | undefined;
} {
  const coerce = readCoerce(options, 'pinot');
  const { dateStyle = 'string' }: PinotInlineOptions = options ?? {};
  if (!DATE_STYLES.includes(dateStyle)) {
    return fail('invalid dateStyle');
  }

  return { dateStyle, coerce };
}

/** Render a query to a Pinot SQL string with every value inlined as a literal.
 *
 * Strings use `''` escaping only (backslashes, `"` and newlines stay verbatim); numbers must
 * be finite safe integers or non-integers (use `bigint` for larger ones); `Uint8Array` renders
 * as `X'…'`. A space is inserted where a literal would otherwise fuse with adjacent text
 * (`a-${-1}`, `X${'41'}`). Throws {@link SqlDialectError} for unsupported values, values
 * inside quotes or comments, or a malformed query. The input is never mutated.
 *
 * @public
 */
export function inline(query: Sql, options?: PinotInlineOptions): string {
  const { dateStyle, coerce } = readOptions(options);
  checkQuery(query, PINOT_LEXER);
  const { strings, values } = query;

  let out = strings[0] as string;
  // Tracked instead of read back from `out`, which would flatten the string every iteration.
  let last = out.charCodeAt(out.length - 1);
  for (let i = 0; i < values.length; i++) {
    const literal = renderLiteral(applyCoerce(coerce, values[i]), dateStyle, i);
    const next = strings[i + 1] as string;
    out += needsSpaceBefore(last) ? ' ' + literal : literal;
    if (needsSpaceAfter(next.charCodeAt(0))) {
      out += ' ';
    }

    out += next;
    const tail = next.length > 0 ? next : literal;
    last = tail.charCodeAt(tail.length - 1);
  }

  return out;
}

/** A double-quoted, case-sensitive identifier: `"a"` or, for a list, `"a"."b"`.
 *
 * Never splits on `.`; `"` is doubled. Parts must be non-empty and free of NUL.
 *
 * @public
 */
export function identifier(name: string | readonly string[]): Sql {
  return raw(quoteIdentifier(name, 'pinot'));
}

/** An unquoted identifier matching `/^[A-Za-z_][A-Za-z0-9_]*$/`, emitted verbatim.
 *
 * Note that Pinot reserved words (`timestamp`, `date`, …) need {@link identifier} instead.
 *
 * @public
 */
export function bareIdentifier(name: string): Sql {
  return raw(assertBareIdentifier(name, IDENTIFIER_PATTERN, 'pinot'));
}

/** An `ARRAY[v1,v2,…]` literal whose elements follow the normal value rules.
 *
 * @public
 */
export function array(values: readonly RawValue[]): Sql {
  if (!Array.isArray(values) || values.length === 0) {
    return fail('array() requires a non-empty array');
  }

  return new Sql(
    ['ARRAY[', ...Array<string>(values.length - 1).fill(','), ']'],
    values,
  );
}

function optionValue(key: string, value: unknown): string {
  switch (typeof value) {
    case 'string':
      return quotePinotString(value);
    case 'bigint':
      return formatBigint(value);
    case 'boolean':
      return String(value);
    case 'number':
      if (!Number.isFinite(value)) {
        return fail(`queryOptions.${key}: non-finite number`);
      }

      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        return fail(`queryOptions.${key}: unsafe integer, use bigint`);
      }

      return formatNumber(value);
    default:
      return fail(`queryOptions.${key}: unsupported value type`);
  }
}

/** `SET key = value;` lines for Pinot query options, one per defined key, in insertion order.
 *
 * Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`; `undefined` values are skipped; strings are
 * quoted, numbers and `bigint`s are bare, booleans are lowercase. Returns `empty` when no
 * option is left. For the multi-stage engine use `queryOptions({ useMultistageEngine: true })`.
 *
 * @public
 */
export function queryOptions(
  options: Readonly<
    Record<string, string | number | bigint | boolean | undefined>
  >,
): Sql {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    return fail('queryOptions() requires an object');
  }

  let text = '';
  for (const [key, value] of Object.entries(options)) {
    if (!IDENTIFIER_PATTERN.test(key)) {
      return fail(`invalid query option name ${JSON.stringify(key)}`);
    }

    if (value !== undefined) {
      text += `SET ${key} = ${optionValue(key, value)};\n`;
    }
  }

  return text === '' ? empty : raw(text);
}
