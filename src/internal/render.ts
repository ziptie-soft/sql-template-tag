/** Steps shared by the dialect renderers (Pinot `inline`, Snowflake `bind`).
 *
 * @packageDocumentation
 * @internal
 */

import type { Sql } from '../index.js';
import { SqlDialectError, type Dialect } from './errors.js';
import { assertValueBoundaries, type LexerConfig } from './lexer.js';
import {
  assertShape,
  classify,
  formatBigint,
  formatNumber,
  Kind,
  needsSpaceAfter,
  needsSpaceBefore,
} from './literals.js';

/** Maps a custom value (Luxon, Temporal, …) to a supported one before classification.
 *
 * @internal
 */
export type Coerce = (value: unknown) => unknown;

/** Throw a {@link SqlDialectError} without a value index.
 *
 * @internal
 */
export function fail(dialect: Dialect, reason: string): never {
  throw new SqlDialectError(dialect, reason);
}

/** Validate a renderer options object and return its `coerce` function, if any.
 *
 * @internal
 */
export function readCoerce(
  options: { readonly coerce?: Coerce } | undefined,
  dialect: Dialect,
): Coerce | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (typeof options !== 'object' || options === null) {
    return fail(dialect, 'options must be an object');
  }

  const { coerce } = options;
  if (coerce !== undefined && typeof coerce !== 'function') {
    return fail(dialect, 'coerce must be a function');
  }

  return coerce;
}

/** Run the optional `coerce` hook on one value.
 *
 * @internal
 */
export function applyCoerce(
  coerce: Coerce | undefined,
  value: unknown,
): unknown {
  return coerce === undefined ? value : coerce(value);
}

/** Structural check plus lexical context guard: the common prologue of every renderer.
 *
 * @internal
 */
export function checkQuery(query: Sql, lexer: LexerConfig): void {
  assertShape(query, lexer.dialect);
  assertValueBoundaries(query.strings, lexer);
}

/** Renders one classified-and-validated value as SQL literal text.
 *
 * @internal
 */
export type LiteralRenderer = (value: unknown, index: number) => string;

/** The dialect-specific part of literal rendering; null, booleans, numbers and bigints are
 * shared.
 *
 * @internal
 */
export interface LiteralFormats {
  readonly string: (value: string, index: number) => string;
  readonly date: (value: Date) => string;
  readonly bytes: (value: Uint8Array) => string;
}

/** Build a {@link LiteralRenderer}: classify (throwing for unsupported values), then format.
 * Call once per dialect or style, not per value.
 *
 * @internal
 */
export function literalRenderer(
  dialect: Dialect,
  formats: LiteralFormats,
): LiteralRenderer {
  return (value, index) => {
    switch (classify(value, dialect, index)) {
      case Kind.NULL:
        return 'NULL';
      case Kind.BOOLEAN:
        return value === true ? 'TRUE' : 'FALSE';
      case Kind.NUMBER:
        return formatNumber(value as number);
      case Kind.BIGINT:
        return formatBigint(value as bigint);
      case Kind.STRING:
        return formats.string(value as string, index);
      case Kind.DATE:
        return formats.date(value as Date);
      default:
        return formats.bytes(value as Uint8Array);
    }
  };
}

/** Render a query to one string with every value inlined as a literal.
 *
 * One linear pass. A space is inserted where a literal would otherwise fuse with adjacent
 * template text (`a-${-1}`, `X${'41'}`); everything else is copied byte for byte. The caller
 * has already validated the query with {@link checkQuery}.
 *
 * @internal
 */
export function renderInline(
  query: Sql,
  coerce: Coerce | undefined,
  renderLiteral: LiteralRenderer,
): string {
  const { strings, values } = query;
  let out = strings[0] as string;
  // Tracked instead of read back from `out`, which would flatten the string every iteration.
  let last = out.charCodeAt(out.length - 1);
  for (let i = 0; i < values.length; i++) {
    const literal = renderLiteral(applyCoerce(coerce, values[i]), i);
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
