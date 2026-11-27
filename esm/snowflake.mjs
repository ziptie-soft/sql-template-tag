// ESM entry for `./snowflake`: a thin wrapper over the CommonJS build so that `import` and
// `require` share one `Sql` class (no dual-package hazard for `instanceof`).
import cjs from './dialects/snowflake.js';

export const {
  SqlDialectError,
  bareIdentifier,
  bind,
  identifier,
  inline,
  rows,
  variant,
} = cjs;
