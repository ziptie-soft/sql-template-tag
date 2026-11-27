// ESM entry for `./pinot`: a thin wrapper over the CommonJS build so that `import` and
// `require` share one `Sql` class (no dual-package hazard for `instanceof`).
import cjs from './dialects/pinot.js';

export const {
  SqlDialectError,
  array,
  bareIdentifier,
  identifier,
  inline,
  queryOptions,
} = cjs;
