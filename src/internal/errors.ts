/** SQL dialects supported by the internal renderers.
 *
 * @internal
 */
export type Dialect = 'pinot' | 'snowflake';

/** An error raised while validating or rendering a dialect query.
 *
 * @public
 */
export class SqlDialectError extends TypeError {
  override readonly name = 'SqlDialectError';
  readonly dialect: Dialect;
  readonly index: number | undefined;
  readonly reason: string;

  constructor(dialect: Dialect, reason: string, index?: number) {
    const suffix = index === undefined ? '' : ` (value #${index})`;
    super(`[${dialect}] ${reason}${suffix}`);
    this.dialect = dialect;
    this.index = index;
    this.reason = reason;
  }
}
