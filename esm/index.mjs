// ESM entry: a thin wrapper over the CommonJS build so that `import` and
// `require` share one `Sql` class (no dual-package hazard for `instanceof`).
import cjs from './index.js';

export const { Sql, bulk, empty, join, raw } = cjs;
export default cjs.default;
