import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import sql, { bulk, empty, join, raw, Sql } from '../src/index.js';

void describe('sql template tag', async () => {
  await it('should generate sql', () => {
    const query = sql`SELECT * FROM books`;

    assert.deepStrictEqual(query.sql, 'SELECT * FROM books');
    assert.deepStrictEqual(query.text, 'SELECT * FROM books');
    assert.deepStrictEqual(query.statement, 'SELECT * FROM books');
    assert.deepStrictEqual(query.values, []);
  });

  await it('should embed sql in sql', () => {
    const tableName = sql`books`;
    const query = sql`SELECT * FROM ${tableName}`;

    assert.deepStrictEqual(query.sql, 'SELECT * FROM books');
    assert.deepStrictEqual(query.text, 'SELECT * FROM books');
    assert.deepStrictEqual(query.statement, 'SELECT * FROM books');
    assert.deepStrictEqual(query.values, []);
  });

  await it('should store values', () => {
    const name = 'Blake';
    const query = sql`SELECT * FROM books WHERE author = ${name}`;

    assert.deepStrictEqual(query.sql, 'SELECT * FROM books WHERE author = ?');
    assert.deepStrictEqual(query.text, 'SELECT * FROM books WHERE author = $1');
    assert.deepStrictEqual(
      query.statement,
      'SELECT * FROM books WHERE author = :1',
    );
    assert.deepStrictEqual(query.values, [name]);
  });

  await it('should build sql with child sql statements', () => {
    const subquery = sql`SELECT id FROM authors WHERE name = ${'Blake'}`;
    const query = sql`SELECT * FROM books WHERE author_id IN (${subquery})`;

    assert.deepStrictEqual(
      query.sql,
      'SELECT * FROM books WHERE author_id IN (SELECT id FROM authors WHERE name = ?)',
    );
    assert.deepStrictEqual(
      query.text,
      'SELECT * FROM books WHERE author_id IN (SELECT id FROM authors WHERE name = $1)',
    );
    assert.deepStrictEqual(
      query.statement,
      'SELECT * FROM books WHERE author_id IN (SELECT id FROM authors WHERE name = :1)',
    );
    assert.deepStrictEqual(query.values, ['Blake']);
  });

  await it('should not cache values for mysql compatibility', () => {
    const ids = [1, 2, 3];
    const query = sql`SELECT * FROM books WHERE id IN (${join(
      ids,
    )}) OR author_id IN (${join(ids)})`;

    assert.deepStrictEqual(
      query.sql,
      'SELECT * FROM books WHERE id IN (?,?,?) OR author_id IN (?,?,?)',
    );
    assert.deepStrictEqual(
      query.text,
      'SELECT * FROM books WHERE id IN ($1,$2,$3) OR author_id IN ($4,$5,$6)',
    );
    assert.deepStrictEqual(
      query.statement,
      'SELECT * FROM books WHERE id IN (:1,:2,:3) OR author_id IN (:4,:5,:6)',
    );
    assert.deepStrictEqual(query.values, [1, 2, 3, 1, 2, 3]);
  });

  await it('should provide "empty" helper', () => {
    const query = sql`SELECT * FROM books ${empty}`;

    assert.deepStrictEqual(query.sql, 'SELECT * FROM books ');
    assert.deepStrictEqual(query.text, 'SELECT * FROM books ');
    assert.deepStrictEqual(query.statement, 'SELECT * FROM books ');
    assert.deepStrictEqual(query.values, []);
  });

  await it('should throw in constructor with no strings', () => {
    assert.throws(() => new Sql([], []), {
      message: 'Expected at least 1 string',
    });
  });

  await it('should throw when values is less than expected', () => {
    assert.throws(() => new Sql(['', ''], []), {
      message: 'Expected 2 strings to have 1 values',
    });
  });

  await it('should inspect sql instance', () => {
    assert.ok(
      inspect(sql`SELECT * FROM test`).includes(`'SELECT * FROM test'`),
    );
  });

  await it('should expose all formats via inspect()', () => {
    assert.deepStrictEqual(sql`SELECT ${1}`.inspect(), {
      sql: 'SELECT ?',
      statement: 'SELECT :1',
      text: 'SELECT $1',
      values: [1],
    });
  });

  await it('should handle escaped back ticks', () => {
    const query = sql`UPDATE user SET \`name\` = 'Taylor'`;

    assert.deepStrictEqual(query.text, "UPDATE user SET `name` = 'Taylor'");
  });

  await describe('join', async () => {
    await it('should join list', () => {
      const query = join([1, 2, 3]);

      assert.deepStrictEqual(query.text, '$1,$2,$3');
      assert.deepStrictEqual(query.values, [1, 2, 3]);
    });

    await it('should error joining an empty list', () => {
      assert.throws(() => join([]), TypeError);
    });

    await it('should join sql', () => {
      const query = join(
        [
          sql`user.first_name LIKE ${'Test'}`,
          sql`user.last_name LIKE ${'User'}`,
        ],
        ' AND ',
      );

      assert.deepStrictEqual(
        query.text,
        'user.first_name LIKE $1 AND user.last_name LIKE $2',
      );
      assert.deepStrictEqual(query.values, ['Test', 'User']);
    });

    await it('should support one term without separators', () => {
      const query = join([sql`user.first_name LIKE ${'Test'}`], ' AND ');

      assert.deepStrictEqual(query.text, 'user.first_name LIKE $1');
      assert.deepStrictEqual(query.values, ['Test']);
    });

    await it('should configure prefix and suffix characters', () => {
      const query = join([1, 2, 3], ',', '(', ')');

      assert.deepStrictEqual(query.text, '($1,$2,$3)');
      assert.deepStrictEqual(query.values, [1, 2, 3]);
    });
  });

  await describe('raw', async () => {
    await it('should accept any string', () => {
      const value = Math.random().toString();
      const query = raw(value);

      assert.deepStrictEqual(query.sql, value);
      assert.deepStrictEqual(query.values, []);
    });
  });

  await describe('value typing', async () => {
    for (const [type, value] of [
      ['string', 'Blake'],
      ['number', 123],
      ['boolean', true],
      ['Date', new Date('2010-01-01T00:00:00Z')],
      ['null', null],
      ['undefined', undefined],
      ['string array', ['Blake', 'Taylor']],
      ['object', { name: 'Blake' }],
    ] as const) {
      await it(`should allow using ${type} as a value`, () => {
        const query = sql`UPDATE user SET any_value = ${value}`;
        assert.deepStrictEqual(query.values, [value]);
      });
    }
  });

  await describe('bulk', async () => {
    await it('should join nested list', () => {
      const query = bulk([
        [1, 2, 3],
        [5, 2, 3],
      ]);

      assert.deepStrictEqual(query.text, '($1,$2,$3),($4,$5,$6)');
      assert.deepStrictEqual(query.values, [1, 2, 3, 5, 2, 3]);
    });

    await it('should error joining an empty list', () => {
      assert.throws(() => bulk([]), TypeError);
    });

    await it('should error joining an nested empty list', () => {
      assert.throws(() => bulk([[]]), TypeError);
    });

    await it('should error joining an nested non uniform list', () => {
      assert.throws(() => bulk([[1, 2], [1, 3], [1]]), TypeError);
    });
  });
});
