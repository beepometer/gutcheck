// Registry: build system → its source-discipline check set, layered on top of the three language-agnostic
// checks. The probe + gutcheck lint support JS/TS (checks live in gutcheck.default.json, no module here)
// and Python. Other build systems are still *detected* (so lint can say "JS/TS + Python only") but carry
// no checks. `node` is special-cased upstream (its floor IS the default config). This module imports only
// python.mjs (pure config data), so it bundles into dist alongside detect.mjs with no engine dependency.
import { checks as python } from './python.mjs';

export const SOURCE_CHECKS_BY_BUILD = {
  python,
};
