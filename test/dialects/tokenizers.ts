/** Test-only reference tokenizers: an independent oracle for the dialect renderers.
 *
 * `tokenizePinot` follows Calcite's `Lex.MYSQL_ANSI` rules as documented in
 * `docs/dialects-blueprint.md`: `'…'` strings with `''` and no backslash escapes, `"…"`
 * identifiers with `""`, `--` and nested `/* *\/` comments, `X'…'` binary literals and the
 * `N'…'` / `U&'…'` prefixed strings. It never throws: anything unclosed becomes an
 * `unterminated` token, so a test can assert on what a hostile value would have turned into.
 *
 * `tokenizeSnowflake` differs as documented there: `'…'` also processes backslash escapes
 * (`\\`, `\'`, `\0`, `\n`, `\t`, `\r`, `\b`, `\f`; any other `\x` decodes to `x`, so an escape
 * can never be mistaken for a closing quote), `$$…$$` strings are verbatim, `//` starts a line
 * comment, and the `N'…'` / `U&'…'` prefixes do not exist.
 */

export type TokenKind =
  | 'whitespace'
  | 'comment'
  | 'string'
  | 'binary'
  | 'identifier'
  | 'number'
  | 'word'
  | 'operator'
  | 'unterminated';

export interface Token {
  readonly kind: TokenKind;
  /** The exact source text of the token. */
  readonly text: string;
  /** The decoded content of string, binary and identifier tokens; else the text. */
  readonly value: string;
  /** `N` or `U&` for prefixed strings; empty otherwise. */
  readonly prefix: string;
}

/** Lexical differences between the dialects. */
interface Flavor {
  /** A backslash escapes the next character inside `'…'` (Snowflake). */
  readonly backslash: boolean;
  /** Dollar-quoted strings and `//` line comments (Snowflake). */
  readonly snowflake: boolean;
}

const PINOT: Flavor = { backslash: false, snowflake: false };
const SNOWFLAKE: Flavor = { backslash: true, snowflake: true };

const SINGLE = "'";
const DOUBLE = '"';

function token(
  kind: TokenKind,
  text: string,
  value = text,
  prefix = '',
): Token {
  return { kind, text, value, prefix };
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isWordStart(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      char === '_' ||
      char.charCodeAt(0) >= 128)
  );
}

function isWordPart(char: string | undefined): boolean {
  return isWordStart(char) || isDigit(char) || char === '$';
}

function isSpace(char: string | undefined): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f'
  );
}

/** Take the longest run starting at `start` whose characters satisfy `test`. */
function run(
  sql: string,
  start: number,
  test: (char: string | undefined) => boolean,
): number {
  let end = start;
  while (end < sql.length && test(sql[end])) {
    end++;
  }

  return end;
}

interface Quoted {
  readonly end: number;
  readonly value: string;
  readonly closed: boolean;
}

/** Snowflake escapes we are sure of; any other `\x` decodes to `x`, so it can never end a string. */
const SNOWFLAKE_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  'n': '\n',
  't': '\t',
  'r': '\r',
  'b': '\b',
  'f': '\f',
};

/** Scan a quoted body from the opening quote at `start`; a doubled quote decodes to one. */
function scanQuoted(
  sql: string,
  start: number,
  quote: string,
  flavor: Flavor,
): Quoted {
  let value = '';
  let i = start + 1;
  while (i < sql.length) {
    if (flavor.backslash && quote === SINGLE && sql[i] === '\\') {
      if (i + 1 >= sql.length) {
        break;
      }

      const escaped = sql[i + 1] as string;
      value += SNOWFLAKE_ESCAPES[escaped] ?? escaped;
      i += 2;
    } else if (sql[i] !== quote) {
      value += sql[i];
      i++;
    } else if (sql[i + 1] === quote) {
      value += quote;
      i += 2;
    } else {
      return { end: i + 1, value, closed: true };
    }
  }

  return { end: sql.length, value, closed: false };
}

function quotedToken(
  sql: string,
  start: number,
  quote: string,
  kind: TokenKind,
  prefix: string,
  flavor: Flavor,
  tokenStart = start,
): Token {
  const { end, value, closed } = scanQuoted(sql, start, quote, flavor);
  const text = sql.slice(tokenStart, end);
  return closed
    ? token(kind, text, value, prefix)
    : token('unterminated', text);
}

/** A Snowflake dollar-quoted string: verbatim body, no escapes. */
function dollarString(sql: string, start: number): Token {
  const close = sql.indexOf('$$', start + 2);
  if (close === -1) {
    return token('unterminated', sql.slice(start));
  }

  return token(
    'string',
    sql.slice(start, close + 2),
    sql.slice(start + 2, close),
  );
}

function lineComment(sql: string, start: number): Token {
  let end = sql.indexOf('\n', start);
  if (end === -1) {
    end = sql.length;
  }

  return token('comment', sql.slice(start, end));
}

function blockComment(sql: string, start: number): Token {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    const pair = sql.slice(i, i + 2);
    if (pair === '/*') {
      depth++;
      i += 2;
    } else if (pair === '*/' && depth > 0) {
      depth--;
      i += 2;
      if (depth === 0) {
        break;
      }
    } else {
      i++;
    }
  }

  const text = sql.slice(start, i);
  return depth === 0 ? token('comment', text) : token('unterminated', text);
}

function number(sql: string, start: number): Token {
  let end = run(sql, start, isDigit);
  if (sql[end] === '.') {
    end = run(sql, end + 1, isDigit);
  }

  const exponent = /^[eE][+-]?\d+/.exec(sql.slice(end));
  if (exponent !== null) {
    end += exponent[0].length;
  }

  return token('number', sql.slice(start, end));
}

/** A word, or a prefixed string when the word is directly followed by a quote. */
function word(sql: string, start: number, flavor: Flavor): Token {
  const end = run(sql, start, isWordPart);
  const text = sql.slice(start, end);
  const upper = text.toUpperCase();
  if (sql[end] === SINGLE) {
    if (upper === 'X') {
      return quotedToken(sql, end, SINGLE, 'binary', '', flavor, start);
    }

    if (upper === 'N' && !flavor.snowflake) {
      return quotedToken(sql, end, SINGLE, 'string', 'N', flavor, start);
    }
  }

  if (upper === 'U' && !flavor.snowflake && sql.startsWith("&'", end)) {
    return quotedToken(sql, end + 1, SINGLE, 'string', 'U&', flavor, start);
  }

  return token('word', text);
}

const TWO_CHAR_OPERATORS = ['<=', '>=', '<>', '!=', '||'];

function operator(sql: string, start: number): Token {
  const pair = sql.slice(start, start + 2);
  return token(
    'operator',
    TWO_CHAR_OPERATORS.includes(pair) ? pair : (sql[start] as string),
  );
}

/** Comments, plus Snowflake's dollar-quoted strings, which also start with two fixed characters. */
function scanOpener(
  sql: string,
  start: number,
  flavor: Flavor,
): Token | undefined {
  const pair = sql.slice(start, start + 2);
  if (pair === '--' || (flavor.snowflake && pair === '//')) {
    return lineComment(sql, start);
  }

  if (flavor.snowflake && pair === '$$') {
    return dollarString(sql, start);
  }

  return pair === '/*' ? blockComment(sql, start) : undefined;
}

function scanToken(sql: string, start: number, flavor: Flavor): Token {
  const char = sql[start];
  const next = sql[start + 1];
  if (isSpace(char)) {
    return token('whitespace', sql.slice(start, run(sql, start, isSpace)));
  }

  const opener = scanOpener(sql, start, flavor);
  if (opener !== undefined) {
    return opener;
  }

  if (char === SINGLE) {
    return quotedToken(sql, start, SINGLE, 'string', '', flavor);
  }

  if (char === DOUBLE) {
    return quotedToken(sql, start, DOUBLE, 'identifier', '', flavor);
  }

  if (isDigit(char) || (char === '.' && isDigit(next))) {
    return number(sql, start);
  }

  return isWordStart(char) ? word(sql, start, flavor) : operator(sql, start);
}

function tokenize(sql: string, flavor: Flavor): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const next = scanToken(sql, i, flavor);
    tokens.push(next);
    i += next.text.length;
  }

  return tokens;
}

/** Split Pinot SQL into tokens; the token texts always concatenate back to the input. */
export function tokenizePinot(sql: string): Token[] {
  return tokenize(sql, PINOT);
}

/** Split Snowflake SQL into tokens (backslash escapes, `$$` strings, `//` comments). */
export function tokenizeSnowflake(sql: string): Token[] {
  return tokenize(sql, SNOWFLAKE);
}

/** Compact, whitespace-free token summaries for readable assertions. */
export function summarize(
  sql: string,
  tokenizer: (sql: string) => Token[] = tokenizePinot,
): string[] {
  const out: string[] = [];
  for (const { kind, text, value, prefix } of tokenizer(sql)) {
    if (kind === 'whitespace') {
      continue;
    }

    if (kind === 'string') {
      out.push(`${prefix}str(${value})`);
    } else if (kind === 'binary') {
      out.push(`bin(${value})`);
    } else if (kind === 'identifier') {
      out.push(`id(${value})`);
    } else {
      out.push(kind === 'unterminated' ? 'unterminated' : text);
    }
  }

  return out;
}

/** Decoded values of every plain (unprefixed) string-literal token, in order. */
export function stringLiterals(tokens: readonly Token[]): string[] {
  return tokens
    .filter((t) => t.kind === 'string' && t.prefix === '')
    .map((t) => t.value);
}

/** Decoded values of every quoted-identifier token, in order. */
export function quotedIdentifiers(tokens: readonly Token[]): string[] {
  return tokens.filter((t) => t.kind === 'identifier').map((t) => t.value);
}

/** Count `;`-separated statements that contain at least one significant token. */
export function statementCount(tokens: readonly Token[]): number {
  let count = 0;
  let open = false;
  for (const { kind, text } of tokens) {
    if (kind === 'operator' && text === ';') {
      open = false;
    } else if (kind !== 'whitespace' && kind !== 'comment' && !open) {
      open = true;
      count++;
    }
  }

  return count;
}
