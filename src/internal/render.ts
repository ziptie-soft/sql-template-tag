/** Steps shared by the dialect renderers (Pinot `inline`, Snowflake `bind`).
 *
 * @packageDocumentation
 * @internal
 */

import type { Sql } from '../index.js';
import { SqlDialectError, type Dialect } from './errors.js';
import { assertValueBoundaries, type LexerConfig } from './lexer.js';
import { assertShape } from './literals.js';

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
