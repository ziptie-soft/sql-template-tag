/**
 * Values supported by SQL engine.
 *
 * @public
 */
export type Value = unknown;

/**
 * Supported value or SQL instance.
 *
 * @public
 */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `Sql` documents intent
export type RawValue = Value | Sql;

/**
 * A SQL instance can be nested within each other to build SQL strings.
 *
 * @public
 */
export class Sql {
  readonly values: Value[];
  readonly strings: string[];

  constructor(rawStrings: readonly string[], rawValues: readonly RawValue[]) {
    if (rawStrings.length - 1 !== rawValues.length) {
      if (rawStrings.length === 0) {
        throw new TypeError('Expected at least 1 string');
      }

      throw new TypeError(
        `Expected ${rawStrings.length} strings to have ${
          rawStrings.length - 1
        } values`,
      );
    }

    const valuesLength = rawValues.reduce<number>(
      (len, value) => len + (value instanceof Sql ? value.values.length : 1),
      0,
    );

    // Pre-sized arrays are intentional (hot path, see benchmarks).
    // oxlint-disable-next-line unicorn/no-new-array
    this.values = new Array(valuesLength);
    // oxlint-disable-next-line unicorn/no-new-array
    this.strings = new Array(valuesLength + 1);

    this.strings[0] = rawStrings[0] as string;

    // Iterate over raw values, strings, and children. The value is always
    // positioned between two strings, e.g. `index + 1`.
    let i = 0,
      pos = 0;
    while (i < rawValues.length) {
      const child = rawValues[i++];
      const rawString = rawStrings[i] as string;

      // Check for nested `sql` queries.
      if (child instanceof Sql) {
        // Append child prefix text to current string.
        this.strings[pos] += child.strings[0] as string;

        let childIndex = 0;
        while (childIndex < child.values.length) {
          this.values[pos++] = child.values[childIndex++];
          this.strings[pos] = child.strings[childIndex] as string;
        }

        // Append raw string to current string.
        this.strings[pos] += rawString;
      } else {
        this.values[pos++] = child;
        this.strings[pos] = rawString;
      }
    }
  }

  get sql(): string {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0] as string;
    while (i < len) value += `?${this.strings[i++] as string}`;
    return value;
  }

  get statement(): string {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0] as string;
    while (i < len) value += `:${i}${this.strings[i++] as string}`;
    return value;
  }

  get text(): string {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0] as string;
    while (i < len) value += `$${i}${this.strings[i++] as string}`;
    return value;
  }

  inspect(): {
    sql: string;
    statement: string;
    text: string;
    values: Value[];
  } {
    return {
      sql: this.sql,
      statement: this.statement,
      text: this.text,
      values: this.values,
    };
  }
}

/**
 * Create a SQL query for a list of values.
 *
 * @public
 */
export function join(
  values: readonly RawValue[],
  separator = ',',
  prefix = '',
  suffix = '',
): Sql {
  if (values.length === 0) {
    throw new TypeError(
      'Expected `join([])` to be called with an array of multiple elements, but got an empty array',
    );
  }

  return new Sql(
    [prefix, ...Array(values.length - 1).fill(separator), suffix],
    values,
  );
}

/**
 * Create a SQL query for a list of structured values.
 *
 * @public
 */
export function bulk(
  data: ReadonlyArray<ReadonlyArray<RawValue>>,
  separator = ',',
  prefix = '',
  suffix = '',
): Sql {
  const length = data.length && (data[0] as ReadonlyArray<RawValue>).length;

  if (length === 0) {
    throw new TypeError(
      'Expected `bulk([][])` to be called with a nested array of multiple elements, but got an empty array',
    );
  }

  const values = data.map((item, index): Sql => {
    if (item.length !== length) {
      throw new TypeError(
        `Expected \`bulk([${index}][])\` to have a length of ${length}, but got ${item.length}`,
      );
    }

    return new Sql(['(', ...Array(item.length - 1).fill(separator), ')'], item);
  });

  return new Sql(
    [prefix, ...Array(values.length - 1).fill(separator), suffix],
    values,
  );
}

/**
 * Create raw SQL statement.
 *
 * @public
 */
export function raw(value: string): Sql {
  return new Sql([value], []);
}

/**
 * Placeholder value for "no text".
 *
 * @public
 */
export const empty = raw('');

/**
 * Create a SQL object from a template string.
 *
 * @public
 */
export default function sql(
  strings: readonly string[],
  ...values: readonly RawValue[]
): Sql {
  return new Sql(strings, values);
}
