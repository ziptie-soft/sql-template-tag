/** Test-only reference tokenizers: an independent oracle for the dialect renderers.
 *
 * `tokenizePinot` follows Calcite's `Lex.MYSQL_ANSI` rules as documented in
 * `docs/dialects-blueprint.md`: `'…'` strings with `''` and no backslash escapes, `"…"`
 * identifiers with `""`, `--` and nested `/* *\/` comments, `X'…'` binary literals and the
 * `N'…'` / `U&'…'` prefixed strings. It never throws: anything unclosed becomes an
 * `unterminated` token, so a test can assert on what a hostile value would have turned into.
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

/** Scan a quoted body from the opening quote at `start`; a doubled quote decodes to one. */
function scanQuoted(sql: string, start: number, quote: string): Quoted {
  let value = '';
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] !== quote) {
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
  tokenStart = start,
): Token {
  const { end, value, closed } = scanQuoted(sql, start, quote);
  const text = sql.slice(tokenStart, end);
  return closed
    ? token(kind, text, value, prefix)
    : token('unterminated', text);
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
function word(sql: string, start: number): Token {
  const end = run(sql, start, isWordPart);
  const text = sql.slice(start, end);
  const upper = text.toUpperCase();
  if (sql[end] === SINGLE) {
    if (upper === 'X') {
      return quotedToken(sql, end, SINGLE, 'binary', '', start);
    }

    if (upper === 'N') {
      return quotedToken(sql, end, SINGLE, 'string', 'N', start);
    }
  }

  if (upper === 'U' && sql.startsWith("&'", end)) {
    return quotedToken(sql, end + 1, SINGLE, 'string', 'U&', start);
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

function scanToken(sql: string, start: number): Token {
  const char = sql[start];
  const next = sql[start + 1];
  if (isSpace(char)) {
    return token('whitespace', sql.slice(start, run(sql, start, isSpace)));
  }

  if (char === '-' && next === '-') {
    return lineComment(sql, start);
  }

  if (char === '/' && next === '*') {
    return blockComment(sql, start);
  }

  if (char === SINGLE) {
    return quotedToken(sql, start, SINGLE, 'string', '');
  }

  if (char === DOUBLE) {
    return quotedToken(sql, start, DOUBLE, 'identifier', '');
  }

  if (isDigit(char) || (char === '.' && isDigit(next))) {
    return number(sql, start);
  }

  return isWordStart(char) ? word(sql, start) : operator(sql, start);
}

/** Split Pinot SQL into tokens; the token texts always concatenate back to the input. */
export function tokenizePinot(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const next = scanToken(sql, i);
    tokens.push(next);
    i += next.text.length;
  }

  return tokens;
}

/** Compact, whitespace-free token summaries for readable assertions. */
export function summarize(sql: string): string[] {
  const out: string[] = [];
  for (const { kind, text, value, prefix } of tokenizePinot(sql)) {
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
