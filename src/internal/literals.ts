import { SqlDialectError, type Dialect } from './errors.js';

/** Numeric tags for supported SQL scalar kinds.
 *
 * @internal
 */
export const Kind = {
  NULL: 0,
  BOOLEAN: 1,
  NUMBER: 2,
  BIGINT: 3,
  STRING: 4,
  DATE: 5,
  BYTES: 6,
} as const;

/** A supported SQL scalar kind.
 *
 * @internal
 */
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Structural view of a `Sql` instance (a structured clone qualifies). */
type QueryShape = {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
};

function invalid(dialect: Dialect, reason: string, index: number): never {
  throw new SqlDialectError(dialect, reason, index);
}

function classifyNumber(value: number, dialect: Dialect, index: number): Kind {
  if (!Number.isFinite(value)) {
    return invalid(dialect, 'non-finite number', index);
  }

  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return invalid(dialect, 'unsafe integer, use bigint', index);
  }

  return Kind.NUMBER;
}

/** `0000-01-01T00:00:00.000Z` and `9999-12-31T23:59:59.999Z` in epoch milliseconds. */
const MIN_DATE_TIME = -62_167_219_200_000;
const MAX_DATE_TIME = 253_402_300_799_999;

function classifyDate(time: number, dialect: Dialect, index: number): Kind {
  if (Number.isNaN(time)) {
    return invalid(dialect, 'invalid date', index);
  }

  if (time < MIN_DATE_TIME || time > MAX_DATE_TIME) {
    return invalid(dialect, 'date out of range', index);
  }

  return Kind.DATE;
}

// Intrinsics captured at load time. They read internal slots, so they work across realms
// (vm, jest), cannot be spoofed with `Symbol.toStringTag`, and ignore methods or getters
// overridden by a `Date` / `Uint8Array` subclass (which could otherwise return SQL text).
const { getTime, toISOString } = Date.prototype as {
  getTime: (this: unknown) => number;
  toISOString: (this: unknown) => string;
};
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
type Getter = (this: unknown) => unknown;
function intrinsicGetter(key: PropertyKey): Getter {
  return (
    Object.getOwnPropertyDescriptor(typedArrayPrototype, key) as {
      get: Getter;
    }
  ).get;
}
const typedArrayTag = intrinsicGetter(Symbol.toStringTag) as (
  this: unknown,
) => string | undefined;
const typedArrayLength = intrinsicGetter('length') as (this: unknown) => number;
const typedArrayBuffer = intrinsicGetter('buffer') as (
  this: unknown,
) => ArrayBufferLike;

/** Epoch milliseconds of a validated date, read through the intrinsic `getTime`.
 *
 * @internal
 */
export function dateMillis(value: Date): number {
  return getTime.call(value);
}

/** The time value of a real `Date` (brand check via the intrinsic), or `undefined`. */
function dateTimeOf(value: object): number | undefined {
  try {
    return getTime.call(value);
  } catch {
    return undefined;
  }
}

function isUint8Array(value: object): value is Uint8Array {
  return typedArrayTag.call(value) === 'Uint8Array';
}

function classifyBytes(
  value: Uint8Array,
  dialect: Dialect,
  index: number,
): Kind {
  const buffer = typedArrayBuffer.call(value) as { detached?: boolean };
  if (buffer.detached === true) {
    return invalid(dialect, 'byte array buffer is detached', index);
  }

  return Kind.BYTES;
}

function classifyObject(value: object, dialect: Dialect, index: number): Kind {
  if (Array.isArray(value)) {
    return invalid(dialect, 'arrays are not values; use join()', index);
  }

  const time = dateTimeOf(value);
  if (time !== undefined) {
    return classifyDate(time, dialect, index);
  }

  if (isUint8Array(value)) {
    return classifyBytes(value, dialect, index);
  }

  if (value instanceof Map) {
    return invalid(
      dialect,
      'Map values are unsupported; use dialect helpers',
      index,
    );
  }

  if (value instanceof Set) {
    return invalid(
      dialect,
      'Set values are unsupported; use dialect helpers',
      index,
    );
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return invalid(dialect, 'only Uint8Array byte values are supported', index);
  }

  return invalid(dialect, 'objects are not values; use dialect helpers', index);
}

/** Classify a supported scalar or throw a dialect error for unsupported input.
 *
 * @internal
 */
export function classify(
  value: unknown,
  dialect: Dialect,
  index: number,
): Kind {
  switch (typeof value) {
    case 'boolean':
      return Kind.BOOLEAN;
    case 'number':
      return classifyNumber(value, dialect, index);
    case 'bigint':
      return Kind.BIGINT;
    case 'string':
      return Kind.STRING;
    case 'undefined':
      return invalid(dialect, 'undefined is not a supported value', index);
    case 'symbol':
      return invalid(dialect, 'symbol values are unsupported', index);
    case 'object':
      return value === null ? Kind.NULL : classifyObject(value, dialect, index);
  }

  // Only `typeof value === 'function'` is left.
  return invalid(dialect, 'function values are unsupported', index);
}

/** Format a finite, supported SQL number.
 *
 * @internal
 */
export function formatNumber(value: number): string {
  return String(value);
}

/** Format a bigint as decimal digits.
 *
 * @internal
 */
export function formatBigint(value: bigint): string {
  return value.toString();
}

/** Format a validated date as a UTC SQL timestamp without quotes.
 *
 * @internal
 */
export function formatDateUtc(value: Date): string {
  return formatDateIso(value).replace('T', ' ').slice(0, 23);
}

/** ISO-8601 UTC text of a validated date, read through the intrinsic `toISOString`.
 *
 * @internal
 */
export function formatDateIso(value: Date): string {
  return toISOString.call(value);
}

/** Quote a string using Apache Pinot's Calcite string rules.
 *
 * @internal
 */
export function quotePinotString(value: string, index?: number): string {
  if (value.indexOf('\0') !== -1) {
    throw new SqlDialectError('pinot', 'NUL is not allowed in strings', index);
  }

  if (value.indexOf("'") === -1) {
    return "'" + value + "'";
  }

  return quoteSlow(value, "'", PINOT_STRING_ESCAPES);
}

/** Quote a string using Snowflake's backslash-aware string rules.
 *
 * @internal
 */
export function quoteSnowflakeString(value: string): string {
  if (
    value.indexOf("'") === -1 &&
    value.indexOf('\\') === -1 &&
    value.indexOf('\0') === -1
  ) {
    return "'" + value + "'";
  }

  return quoteSlow(value, "'", SNOWFLAKE_STRING_ESCAPES);
}

/** Escape replacements indexed by char code; only ASCII is ever escaped. */
type EscapeTable = readonly (string | undefined)[];

function escapeTable(entries: Readonly<Record<string, string>>): EscapeTable {
  const table: (string | undefined)[] = [];
  for (const [char, replacement] of Object.entries(entries)) {
    table[char.charCodeAt(0)] = replacement;
  }

  return table;
}

const PINOT_STRING_ESCAPES = escapeTable({ "'": "''" });
const SNOWFLAKE_STRING_ESCAPES = escapeTable({
  "'": "''",
  '\\': '\\\\',
  '\0': '\\0',
});
const IDENTIFIER_ESCAPES = escapeTable({ '"': '""' });

/** Single pass: copy clean runs with `slice`, substitute escaped chars. */
function quoteSlow(value: string, quote: string, escapes: EscapeTable): string {
  let result = quote;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const replacement = escapes[value.charCodeAt(i)];
    if (replacement !== undefined) {
      result += value.slice(start, i) + replacement;
      start = i + 1;
    }
  }

  return result + value.slice(start) + quote;
}

const HEX_TABLE: readonly string[] = Array.from(
  { length: 256 },
  (_, value): string => value.toString(16).padStart(2, '0'),
);

/** Convert bytes to lowercase hexadecimal using the lookup table.
 *
 * @internal
 */
export function hexFallback(bytes: Uint8Array): string {
  let result = '';
  // Intrinsic length: a subclass `length` getter could point past the end (`undefined`).
  const length = typedArrayLength.call(bytes);
  for (let i = 0; i < length; i++) {
    result += HEX_TABLE[bytes[i] as number];
  }

  return result;
}

type Uint8ArrayWithToHex = Uint8Array & { toHex?: () => string };
const nativeToHex = (Uint8Array.prototype as Uint8ArrayWithToHex).toHex;

/** Convert bytes to lowercase hexadecimal, using the native method when available.
 *
 * @internal
 */
// A bound intrinsic rather than a wrapper function, so no function exists only on runtimes
// with `toHex` (Node.js 25+); coverage is then the same on every supported runtime.
export const hex: (bytes: Uint8Array) => string =
  nativeToHex === undefined
    ? hexFallback
    : (Function.prototype.call.bind(nativeToHex) as (
        bytes: Uint8Array,
      ) => string);

function quoteIdentifierPart(
  part: string,
  dialect: Dialect,
  maxPartLength: number | undefined,
): string {
  if (part.length === 0) {
    throw new SqlDialectError(dialect, 'identifier parts must not be empty');
  }

  if (part.indexOf('\0') !== -1) {
    throw new SqlDialectError(dialect, 'identifier parts must not contain NUL');
  }

  if (maxPartLength !== undefined && part.length > maxPartLength) {
    throw new SqlDialectError(
      dialect,
      'identifier part exceeds maximum length',
    );
  }

  if (part.indexOf('"') === -1) {
    return '"' + part + '"';
  }

  return quoteSlow(part, '"', IDENTIFIER_ESCAPES);
}

/** Quote one identifier part or a sequence of separately quoted parts.
 *
 * `maxPartLength` counts UTF-16 code units.
 *
 * @internal
 */
export function quoteIdentifier(
  name: string | readonly string[],
  dialect: Dialect,
  maxPartLength?: number,
): string {
  if (typeof name === 'string') {
    return quoteIdentifierPart(name, dialect, maxPartLength);
  }

  if (!Array.isArray(name) || name.length === 0) {
    throw new SqlDialectError(
      dialect,
      'identifier must contain at least one part',
    );
  }

  const parts: string[] = [];
  for (let i = 0; i < name.length; i++) {
    const part: unknown = name[i];
    if (typeof part !== 'string') {
      throw new SqlDialectError(dialect, 'identifier parts must be strings');
    }

    parts.push(quoteIdentifierPart(part, dialect, maxPartLength));
  }

  return parts.join('.');
}

/** Validate an unquoted identifier against a dialect-specific pattern.
 *
 * `pattern` must be anchored and must not use the `g` or `y` flag.
 *
 * @internal
 */
export function assertBareIdentifier(
  name: string,
  pattern: RegExp,
  dialect: Dialect,
): string {
  if (typeof name !== 'string' || !pattern.test(name)) {
    throw new SqlDialectError(dialect, 'invalid bare identifier');
  }

  return name;
}

/** Validate the structural shape expected by dialect renderers.
 *
 * @internal
 */
export function assertShape(query: QueryShape, dialect: Dialect): void {
  const reason = shapeError(query);
  if (reason !== undefined) {
    throw new SqlDialectError(dialect, reason);
  }
}

function shapeError(query: QueryShape): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return 'query must be an object';
  }

  const { strings, values } = query;
  if (!Array.isArray(strings) || !Array.isArray(values)) {
    return 'query strings and values must be arrays';
  }

  if (strings.length !== values.length + 1) {
    return 'query strings and values have inconsistent lengths';
  }

  for (let i = 0; i < strings.length; i++) {
    if (typeof strings[i] !== 'string') {
      return 'query strings must contain only strings';
    }
  }

  return undefined;
}

function createCharacterTable(characters: string): Uint8Array {
  const table = new Uint8Array(128);
  for (let i = 0; i < characters.length; i++) {
    const code = characters.charCodeAt(i);
    table[code] = 1;
  }

  return table;
}

const SPACE_BEFORE = createCharacterTable(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$&\'".-',
);
const SPACE_AFTER = createCharacterTable(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$\'".',
);

/** Check whether a preceding character can fuse with an inline literal.
 * Non-ASCII characters may be identifier characters, so they always need a space.
 *
 * @internal
 */
export function needsSpaceBefore(code: number): boolean {
  return code >= 128 || SPACE_BEFORE[code] === 1;
}

/** Check whether a following character can fuse with an inline literal.
 * Non-ASCII characters may be identifier characters, so they always need a space.
 *
 * @internal
 */
export function needsSpaceAfter(code: number): boolean {
  return code >= 128 || SPACE_AFTER[code] === 1;
}
