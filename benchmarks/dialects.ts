/**
 * Dialect benchmarks and performance budgets (docs/dialects-blueprint.md §5).
 *
 * Run `pnpm run benchmark:dialects`. Pass `--check` (`pnpm run benchmark:dialects -- --check`)
 * to exit 1 when a budget fails; without it the exit code is always 0 (CI non-blocking).
 * No dependencies: timing uses `process.hrtime.bigint()`, heap uses `process.memoryUsage()`,
 * every case is warmed up and the median of several interleaved timed runs is reported.
 * For a GC before each run: `node --expose-gc --import tsx benchmarks/dialects.ts`.
 */

import * as pinot from '../src/dialects/pinot.js';
import * as snowflake from '../src/dialects/snowflake.js';
import sql, { bulk, join, type Sql } from '../src/index.js';
import {
  assertValueBoundaries,
  PINOT_LEXER,
  SNOWFLAKE_BIND_LEXER,
  SNOWFLAKE_INLINE_LEXER,
  type LexerConfig,
} from '../src/internal/lexer.js';

// Budgets (blueprint §5). (a) was revised from 2× to 4×: the core baseline does no per-value
// work, while every dialect render lexes the template and validates each value through
// intrinsics (e.g. `Date.prototype.toISOString`), which a subclass cannot override.
const TYPICAL_MAX_RATIO = 4;
const LINEAR_MAX_RATIO = 10.5;
const LEXER_100KB_MAX_MS = 5;
const LEXER_ADVERSARIAL_MAX_MS = 50;

const RUNS = 7;

interface Case {
  readonly name: string;
  /** Operations per timed run. */
  readonly iters: number;
  /** Returns a number so that the work cannot be optimised away. */
  readonly run: (i: number) => number;
}

interface Result {
  readonly name: string;
  readonly nsPerOp: number;
  readonly heapBytes: number;
}

interface Budget {
  readonly name: string;
  readonly value: string;
  readonly limit: string;
  readonly ok: boolean;
}

// Collects before each run when started with `node --expose-gc --import tsx benchmarks/dialects.ts`;
// otherwise a no-op and the heap column is only a rough, noisy indication.
const collect: () => void =
  (globalThis as { gc?: () => void }).gc ?? ((): void => undefined);

let sink = 0;

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function timeRun(item: Case): { ns: number; heap: number } {
  collect();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < item.iters; i++) {
    acc += item.run(i);
  }

  const end = process.hrtime.bigint();
  const heapAfter = process.memoryUsage().heapUsed;
  sink += acc;
  return {
    ns: Number(end - start) / item.iters,
    heap: heapAfter - heapBefore,
  };
}

/** Warm up every case, then take `RUNS` timed runs interleaved across the cases (so slow
 * drift hits all of them alike) and report each case's median. */
function measure(cases: readonly Case[]): Result[] {
  for (const item of cases) {
    timeRun(item);
    timeRun(item);
  }

  const times = cases.map((): number[] => []);
  const heaps = cases.map((): number[] => []);
  for (let run = 0; run < RUNS; run++) {
    cases.forEach((item, index) => {
      const sample = timeRun(item);
      (times[index] as number[]).push(sample.ns);
      (heaps[index] as number[]).push(sample.heap);
    });
  }

  return cases.map((item, index): Result => ({
    name: item.name,
    nsPerOp: median(times[index] as number[]),
    heapBytes: median(heaps[index] as number[]),
  }));
}

function formatTime(ns: number): string {
  if (ns >= 1e6) {
    return `${(ns / 1e6).toFixed(2)} ms`;
  }

  if (ns >= 1e3) {
    return `${(ns / 1e3).toFixed(2)} µs`;
  }

  return `${ns.toFixed(0)} ns`;
}

function formatOps(ns: number): string {
  return Math.round(1e9 / ns).toLocaleString('en-US');
}

function formatHeap(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function printTable(
  title: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] as string).length)),
  );
  const line = (row: readonly string[]): string =>
    row
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column] as number)
          : cell.padStart(widths[column] as number),
      )
      .join('  ');
  console.log(`\n${title}`);
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(line(row));
  }
}

function printResults(
  title: string,
  results: readonly Result[],
  extra?: (result: Result, index: number) => string,
): void {
  const header = ['case', 'time/op', 'ops/s', 'heap Δ'];
  if (extra) {
    header.push('note');
  }

  printTable(
    title,
    header,
    results.map((result, index) => {
      const row = [
        result.name,
        formatTime(result.nsPerOp),
        formatOps(result.nsPerOp),
        formatHeap(result.heapBytes),
      ];
      if (extra) {
        row.push(extra(result, index));
      }

      return row;
    }),
  );
}

function ratioBudget(name: string, value: number, limit: number): Budget {
  return {
    name,
    value: `${value.toFixed(2)}×`,
    limit: `≤ ${limit}×`,
    ok: value <= limit,
  };
}

function msBudget(name: string, ms: number, limit: number): Budget {
  return {
    name,
    value: `${ms.toFixed(2)} ms`,
    limit: `< ${limit} ms`,
    ok: ms < limit,
  };
}

// (a) Typical query ---------------------------------------------------------------------

const DATE = new Date('2024-01-02T03:04:05.678Z');

function typicalQuery(i: number): Sql {
  const region = sql`region = ${'eu'}`;
  return sql`SELECT id, name FROM users WHERE name = ${'alice'} AND age > ${i} AND created < ${DATE} AND ${region} AND id IN (${join([1, 2, 3, 4, 5])})`;
}

function scenarioTypical(): Budget[] {
  const results = measure([
    {
      name: 'core .sql + .values (baseline)',
      iters: 100_000,
      run: (i) => {
        const query = typicalQuery(i);
        return query.sql.length + query.values.length;
      },
    },
    {
      name: 'pinot inline',
      iters: 100_000,
      run: (i) => pinot.inline(typicalQuery(i)).length,
    },
    {
      name: 'snowflake bind',
      iters: 100_000,
      run: (i) => {
        const statement = snowflake.bind(typicalQuery(i));
        return statement.sqlText.length + statement.binds.length;
      },
    },
    {
      name: 'snowflake inline',
      iters: 100_000,
      run: (i) => snowflake.inline(typicalQuery(i)).length,
    },
  ]);
  const baseline = (results[0] as Result).nsPerOp;
  printResults(
    '(a) typical query: 9 values (string, number, Date, nested sql, IN of 5); build + render',
    results,
    (result) => `${(result.nsPerOp / baseline).toFixed(2)}× baseline`,
  );
  return results
    .slice(1)
    .map((result) =>
      ratioBudget(
        `(a) ${result.name} vs core baseline`,
        result.nsPerOp / baseline,
        TYPICAL_MAX_RATIO,
      ),
    );
}

// (b) Escape-heavy strings ----------------------------------------------------------------

const STRING_COUNT = 1000;

function escapeHeavyStrings(): string[] {
  return Array.from({ length: STRING_COUNT }, (_, i) => {
    if (i % 20 === 0) {
      return `it's ${i}`;
    }

    return i % 10 === 0 ? `back\\slash ${i}` : `plain value ${i}`;
  });
}

function scenarioEscapes(): Budget[] {
  const heavy = sql`SELECT ${join(escapeHeavyStrings())}`;
  const clean = sql`SELECT ${join(
    Array.from({ length: STRING_COUNT }, (_, i) => `plain value ${i}`),
  )}`;
  const iters = 500;
  const results = measure([
    {
      name: 'pinot inline, 10% escapes',
      iters,
      run: () => pinot.inline(heavy).length,
    },
    {
      name: 'snowflake inline, 10% escapes',
      iters,
      run: () => snowflake.inline(heavy).length,
    },
    {
      name: 'pinot inline, clean strings',
      iters,
      run: () => pinot.inline(clean).length,
    },
    {
      name: 'snowflake inline, clean strings',
      iters,
      run: () => snowflake.inline(clean).length,
    },
  ]);
  printResults(
    `(b) ${STRING_COUNT} string values rendered (query prebuilt; 10% contain ' or \\)`,
    results,
    (result) => `${(result.nsPerOp / STRING_COUNT).toFixed(0)} ns/string`,
  );
  return [];
}

// (c) IN list scaling ---------------------------------------------------------------------

function inQuery(size: number): Sql {
  const values = Array.from({ length: size }, (_, i) => i);
  return sql`SELECT * FROM t WHERE id IN (${join(values)})`;
}

function scenarioInList(): Budget[] {
  const total = 20_000;
  const cases: Case[] = [];
  const dialects: ReadonlyArray<readonly [string, (query: Sql) => number]> = [
    ['pinot inline', (query) => pinot.inline(query).length],
    ['snowflake bind', (query) => snowflake.bind(query).sqlText.length],
  ];
  for (const [name, render] of dialects) {
    for (const size of [1000, 10_000]) {
      cases.push({
        name: `${name}, ${size / 1000}k values`,
        iters: total / size,
        run: () => render(inQuery(size)),
      });
    }
  }

  const results = measure(cases);
  printResults('(c) IN list via join: build + render', results);
  const budgets: Budget[] = [];
  for (let k = 0; k < results.length; k += 2) {
    const small = results[k] as Result;
    const large = results[k + 1] as Result;
    budgets.push(
      ratioBudget(
        `(c) ${small.name.split(',')[0]}: time(10k) / time(1k)`,
        large.nsPerOp / small.nsPerOp,
        LINEAR_MAX_RATIO,
      ),
    );
  }

  return budgets;
}

// (d) bulk / rows -------------------------------------------------------------------------

function bulkData(): unknown[][] {
  return Array.from({ length: 1000 }, (_, i) => [
    i,
    `name ${i}`,
    i * 1.5,
    DATE,
    i % 2 === 0,
    'x',
    'y',
    i + 1,
    'z',
    `it's ${i}`,
  ]);
}

function scenarioBulk(): Budget[] {
  const data = bulkData();
  const iters = 20;
  const results = measure([
    {
      name: 'pinot inline, bulk 1k×10',
      iters,
      run: () => pinot.inline(sql`INSERT INTO t VALUES ${bulk(data)}`).length,
    },
    {
      name: 'snowflake bind, bulk 1k×10',
      iters,
      run: () =>
        snowflake.bind(sql`INSERT INTO t VALUES ${bulk(data)}`).binds.length,
    },
    {
      name: 'snowflake bind, rows 1k×10',
      iters,
      run: () =>
        snowflake.bind(sql`INSERT INTO t VALUES ${snowflake.rows(data)}`).binds
          .length,
    },
  ]);
  printResults('(d) bulk / rows 1k×10 (10k values): build + render', results);
  return [];
}

// (e) Lexer alone -------------------------------------------------------------------------

const LEXER_CONFIGS: ReadonlyArray<readonly [string, LexerConfig]> = [
  ['pinot', PINOT_LEXER],
  ['snowflake bind', SNOWFLAKE_BIND_LEXER],
  ['snowflake inline', SNOWFLAKE_INLINE_LEXER],
];

/** ~100 KB in 1001 chunks (1000 value boundaries), full of strings, comments and identifiers. */
function lexerTemplate(): string[] {
  const unit =
    `SELECT 'it''s', "Col""x", \`b\`, /* c */ x -- note\n` +
    `, $$raw$$, y // note\n FROM t WHERE y = `;
  const pad = 'x'.repeat(Math.max(0, 100 - unit.length - 2));
  return Array.from({ length: 1001 }, () => `${unit}'${pad}'`);
}

/** Adversarial 1 MB inputs; some stay unterminated on purpose (the lexer throws at the end). */
function adversarialInputs(): ReadonlyArray<readonly [string, string]> {
  return [
    ["runs of ''''", "''''".repeat(250_000)],
    ['runs of /*/*', '/*/*'.repeat(250_000)],
    ['runs of $$$$', '$$$$'.repeat(250_000)],
    ['backslash pairs in a string', `'${'\\\\'.repeat(500_000)}'`],
    ['runs of ----', '----'.repeat(250_000)],
  ];
}

function lex(strings: readonly string[], config: LexerConfig): number {
  try {
    assertValueBoundaries(strings, config);
    return 1;
  } catch {
    return 0;
  }
}

function scenarioLexer(): Budget[] {
  const template = lexerTemplate();
  const templateBytes = template.reduce((sum, chunk) => sum + chunk.length, 0);
  const budgets: Budget[] = [];

  const small = measure(
    LEXER_CONFIGS.map(([name, config]): Case => ({
      name: `${name}, ${(templateBytes / 1000).toFixed(0)} KB / ${template.length - 1} boundaries`,
      iters: 50,
      run: () => lex(template, config),
    })),
  );
  printResults('(e) lexer alone: 100 KB template', small);
  budgets.push(
    msBudget(
      '(e) lexer, 100 KB template (worst dialect)',
      Math.max(...small.map((result) => result.nsPerOp)) / 1e6,
      LEXER_100KB_MAX_MS,
    ),
  );

  for (const [label, text] of adversarialInputs()) {
    const results = measure(
      LEXER_CONFIGS.map(([name, config]): Case => ({
        name,
        iters: 3,
        run: () => lex([text], config),
      })),
    );
    printResults(`(e) lexer alone: 1 MB adversarial, ${label}`, results);
    budgets.push(
      msBudget(
        `(e) lexer, 1 MB ${label} (worst dialect)`,
        Math.max(...results.map((result) => result.nsPerOp)) / 1e6,
        LEXER_ADVERSARIAL_MAX_MS,
      ),
    );
  }

  return budgets;
}

// Main ------------------------------------------------------------------------------------

function printBudgets(budgets: readonly Budget[]): boolean {
  printTable(
    'Budget summary',
    ['budget', 'measured', 'limit', 'result'],
    budgets.map((budget) => [
      budget.name,
      budget.value,
      budget.limit,
      budget.ok ? 'PASS' : 'FAIL',
    ]),
  );
  return budgets.every((budget) => budget.ok);
}

function main(): void {
  console.log(
    `node ${process.version}, ${RUNS} timed runs per case (median); heap Δ = heapUsed change over one run (rough; run with node --expose-gc for a GC before each run)`,
  );
  const budgets = [
    ...scenarioTypical(),
    ...scenarioEscapes(),
    ...scenarioInList(),
    ...scenarioBulk(),
    ...scenarioLexer(),
  ];
  const allPassed = printBudgets(budgets);
  if (sink < 0) {
    console.log(sink);
  }

  if (process.argv.includes('--check') && !allPassed) {
    console.log('\nBudget check failed.');
    process.exitCode = 1;
  }
}

main();
