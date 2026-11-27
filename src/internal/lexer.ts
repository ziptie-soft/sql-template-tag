/** Lexical context guard for dialect renderers.
 *
 * `assertValueBoundaries` walks the template chunks of a `Sql` (`strings`) and checks that
 * every value position, which sits between chunk `i` and chunk `i + 1`, falls in plain SQL
 * text: never inside a string literal, a quoted identifier or a comment. It also rejects
 * any context still open at the end of the text, except a trailing line comment.
 *
 * Security contract:
 * - A value never lands inside quotes or comments, so a rendered literal or placeholder
 *   cannot be swallowed by, or break out of, a surrounding context.
 * - `raw()` text is part of `strings`, so it is lexed too: `${raw("'")}${v}${raw("'")}`
 *   is rejected.
 * - The lexer cannot tell whether `raw()` text is itself malicious. `raw(untrusted)`,
 *   including untrusted text inside a literal, stays a trusted-input escape hatch.
 *
 * The scan is one linear pass with `charCodeAt`: no `join`, no regex, no backtracking and
 * no per-character allocation. Two-character tokens (`--`, `/*`, `*\/`, `//`, `$$`, `''`)
 * are only recognised within one chunk, because a value is inserted at every chunk
 * boundary. Unknown or ambiguous input fails closed: block comments count nesting depth,
 * and line comments end only at LF.
 *
 * @packageDocumentation
 * @internal
 */

import { SqlDialectError, type Dialect } from './errors.js';

/** Per-dialect lexer switches.
 *
 * @internal
 */
export interface LexerConfig {
  /** Dialect reported in errors. */
  readonly dialect: Dialect;
  /** Inside `'…'`, a backslash escapes the next character (Snowflake). */
  readonly backslashInStrings: boolean;
  /** `$$…$$` strings (Snowflake). */
  readonly dollarQuoted: boolean;
  /** `//` line comments (Snowflake). */
  readonly slashSlashComment: boolean;
  /** `` `…` `` quoted context with a doubled backtick escape. */
  readonly backtick: boolean;
  /** A `?` in plain SQL text throws (Snowflake bind mode, which emits `?` placeholders). */
  readonly forbidBareQuestionMark: boolean;
}

/** Lexer config for Apache Pinot (Calcite): no backslash escapes, backtick identifiers.
 *
 * @internal
 */
export const PINOT_LEXER: LexerConfig = Object.freeze({
  dialect: 'pinot',
  backslashInStrings: false,
  dollarQuoted: false,
  slashSlashComment: false,
  backtick: true,
  forbidBareQuestionMark: false,
});

/** Lexer config for Snowflake `bind`, which rejects a bare `?` in template text.
 *
 * @internal
 */
export const SNOWFLAKE_BIND_LEXER: LexerConfig = Object.freeze({
  dialect: 'snowflake',
  backslashInStrings: true,
  dollarQuoted: true,
  slashSlashComment: true,
  backtick: true,
  forbidBareQuestionMark: true,
});

/** Lexer config for Snowflake `inline`, where a bare `?` in template text is allowed.
 *
 * @internal
 */
export const SNOWFLAKE_INLINE_LEXER: LexerConfig = Object.freeze({
  ...SNOWFLAKE_BIND_LEXER,
  forbidBareQuestionMark: false,
});

// Lexer states. Openers of the comment and dollar states are two characters wide.
const NORMAL = 0;
const SINGLE_QUOTE = 1;
const DOUBLE_QUOTE = 2;
const BACKTICK = 3;
const LINE_COMMENT = 4;
const BLOCK_COMMENT = 5;
const DOLLAR_QUOTE = 6;

/** Context names for error reasons, indexed by state. */
const CONTEXT_NAMES: readonly string[] = [
  'plain text',
  'string literal',
  'quoted identifier',
  'backtick identifier',
  'line comment',
  'block comment',
  'dollar-quoted string',
];

/** Opener width in characters, indexed by state. */
const OPENER_WIDTH: readonly number[] = [0, 1, 1, 1, 2, 2, 2];

const LF = 0x0a;
const DOUBLE_QUOTE_CHAR = 0x22;
const DOLLAR = 0x24;
const SINGLE_QUOTE_CHAR = 0x27;
const STAR = 0x2a;
const DASH = 0x2d;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const BACKTICK_CHAR = 0x60;

function createCharacterTable(characters: string): Uint8Array {
  const table = new Uint8Array(128);
  for (let i = 0; i < characters.length; i++) {
    table[characters.charCodeAt(i)] = 1;
  }

  return table;
}

/** Characters that may open a context (or throw) in plain text. */
const TRIGGERS = createCharacterTable('\'"`-/$?');
/** Characters that make a following `$$` part of an identifier (`a$$b`).
 * Digits are excluded so `1$$` opens a dollar string; `a1$$` then also opens one, which fails
 * closed (values after it are rejected rather than possibly landing inside a string).
 */
const IDENTIFIER_CHARS = createCharacterTable(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$',
);

/** Mutable lexer state carried across chunks. */
interface LexState {
  state: number;
  /** Block comment nesting depth. */
  depth: number;
}

function slashOpener(next: number, cfg: LexerConfig): number {
  if (next === STAR) {
    return BLOCK_COMMENT;
  }

  return next === SLASH && cfg.slashSlashComment ? LINE_COMMENT : NORMAL;
}

function dollarOpener(chunk: string, i: number, cfg: LexerConfig): number {
  if (!cfg.dollarQuoted || chunk.charCodeAt(i + 1) !== DOLLAR) {
    return NORMAL;
  }

  // At chunk start the previous character counts as non-identifier.
  const previous = i === 0 ? 0 : chunk.charCodeAt(i - 1);
  return previous < 128 && IDENTIFIER_CHARS[previous] === 1
    ? NORMAL
    : DOLLAR_QUOTE;
}

/** A misplaced `?` is a template-text error, not a value error, so it carries no value index. */
function questionMark(cfg: LexerConfig, index: number): number {
  if (cfg.forbidBareQuestionMark) {
    throw new SqlDialectError(
      cfg.dialect,
      'bare `?` placeholder in template text (chunk ' +
        String(index) +
        '); use a value instead',
    );
  }

  return NORMAL;
}

/** The state opened by the trigger character `code` at `i`, or NORMAL. */
function openerAt(
  chunk: string,
  i: number,
  code: number,
  cfg: LexerConfig,
  index: number,
): number {
  switch (code) {
    case SINGLE_QUOTE_CHAR:
      return SINGLE_QUOTE;
    case DOUBLE_QUOTE_CHAR:
      return DOUBLE_QUOTE;
    case BACKTICK_CHAR:
      return cfg.backtick ? BACKTICK : NORMAL;
    case DASH:
      return chunk.charCodeAt(i + 1) === DASH ? LINE_COMMENT : NORMAL;
    case SLASH:
      return slashOpener(chunk.charCodeAt(i + 1), cfg);
    case DOLLAR:
      return dollarOpener(chunk, i, cfg);
    default:
      // Only `?` is left among TRIGGERS.
      return questionMark(cfg, index);
  }
}

function scanNormal(
  chunk: string,
  start: number,
  cfg: LexerConfig,
  st: LexState,
  index: number,
): number {
  const length = chunk.length;
  for (let i = start; i < length; i++) {
    const code = chunk.charCodeAt(i);
    if (code >= 128 || TRIGGERS[code] === 0) {
      continue;
    }

    const state = openerAt(chunk, i, code, cfg, index);
    if (state !== NORMAL) {
      st.state = state;
      st.depth = 1;
      return i + (OPENER_WIDTH[state] as number);
    }
  }

  return length;
}

/** Scan a quoted context closed by `quote`, where a doubled quote escapes itself. */
function scanQuoted(
  chunk: string,
  start: number,
  quote: number,
  backslash: boolean,
  st: LexState,
): number {
  const length = chunk.length;
  for (let i = start; i < length; i++) {
    const code = chunk.charCodeAt(i);
    if (code === BACKSLASH && backslash) {
      // Skip the escaped character. A trailing `\` leaves the string open.
      i++;
    } else if (code === quote) {
      if (chunk.charCodeAt(i + 1) !== quote) {
        st.state = NORMAL;
        return i + 1;
      }

      i++;
    }
  }

  return length;
}

function scanLineComment(chunk: string, start: number, st: LexState): number {
  const length = chunk.length;
  for (let i = start; i < length; i++) {
    if (chunk.charCodeAt(i) === LF) {
      st.state = NORMAL;
      return i + 1;
    }
  }

  return length;
}

function scanBlockComment(chunk: string, start: number, st: LexState): number {
  const length = chunk.length;
  for (let i = start; i + 1 < length; i++) {
    const code = chunk.charCodeAt(i);
    const next = chunk.charCodeAt(i + 1);
    if (code === STAR && next === SLASH) {
      i++;
      st.depth--;
      if (st.depth === 0) {
        st.state = NORMAL;
        return i + 1;
      }
    } else if (code === SLASH && next === STAR) {
      i++;
      st.depth++;
    }
  }

  return length;
}

function scanDollarQuote(chunk: string, start: number, st: LexState): number {
  const length = chunk.length;
  for (let i = start; i + 1 < length; i++) {
    if (chunk.charCodeAt(i) === DOLLAR && chunk.charCodeAt(i + 1) === DOLLAR) {
      st.state = NORMAL;
      return i + 2;
    }
  }

  return length;
}

/** Scan from `start` until the state changes or the chunk ends; returns the next position. */
function step(
  chunk: string,
  start: number,
  cfg: LexerConfig,
  st: LexState,
  index: number,
): number {
  switch (st.state) {
    case NORMAL:
      return scanNormal(chunk, start, cfg, st, index);
    case SINGLE_QUOTE:
      return scanQuoted(
        chunk,
        start,
        SINGLE_QUOTE_CHAR,
        cfg.backslashInStrings,
        st,
      );
    case DOUBLE_QUOTE:
      return scanQuoted(chunk, start, DOUBLE_QUOTE_CHAR, false, st);
    case BACKTICK:
      return scanQuoted(chunk, start, BACKTICK_CHAR, false, st);
    case LINE_COMMENT:
      return scanLineComment(chunk, start, st);
    case BLOCK_COMMENT:
      return scanBlockComment(chunk, start, st);
    default:
      return scanDollarQuote(chunk, start, st);
  }
}

/** Throw unless every value position in `strings` falls in plain SQL text.
 *
 * `strings` are the `Sql.strings` chunks; value `i` sits between chunk `i` and `i + 1`.
 * Throws `SqlDialectError` with reason `value inside <context>` and the value index, or
 * `unterminated <context>` without an index when a context other than a line comment is
 * still open at the end. In bind mode (`forbidBareQuestionMark`), a `?` in plain text
 * throws without an index; the reason names the chunk that holds it.
 *
 * @internal
 */
export function assertValueBoundaries(
  strings: readonly string[],
  cfg: LexerConfig,
): void {
  const st: LexState = { state: NORMAL, depth: 0 };
  const last = strings.length - 1;
  for (let index = 0; index <= last; index++) {
    const chunk = strings[index] as string;
    const length = chunk.length;
    let i = 0;
    while (i < length) {
      i = step(chunk, i, cfg, st, index);
    }

    if (index < last && st.state !== NORMAL) {
      throw new SqlDialectError(
        cfg.dialect,
        'value inside ' + (CONTEXT_NAMES[st.state] as string),
        index,
      );
    }
  }

  if (st.state !== NORMAL && st.state !== LINE_COMMENT) {
    throw new SqlDialectError(
      cfg.dialect,
      'unterminated ' + (CONTEXT_NAMES[st.state] as string),
    );
  }
}
