import sql, { type Sql } from '../src/index.js';

const formatBytes = (value: number): string =>
  `${(value / 1024 / 1024).toFixed(2)}MB`;

const before = process.memoryUsage();
console.log(
  `before: ${formatBytes(before.heapUsed)} / ${formatBytes(before.heapTotal)}`,
);
const start = process.hrtime();

const queries: Sql[] = [];

for (let i = 0; i < 1_000_000; i++) {
  const rawQuery = sql`there`;
  const subQuery = sql`something ${'goes'} here and ${rawQuery}`;
  const query = sql`this is ${'the'} query: ${i}, ${subQuery}`;
  queries.push(query);

  // Compute properties for perf testing.
  void query.sql;
  void query.text;
  void query.values;
}

const end = process.hrtime(start);
const after = process.memoryUsage();
console.log(
  `after: ${formatBytes(after.heapUsed)} / ${formatBytes(after.heapTotal)}`,
);
console.log(`difference: ${formatBytes(after.heapUsed - before.heapUsed)}`);
console.log(`time: ${end[0]}s ${Math.floor(end[1] / 1_000_000)}ms`);
