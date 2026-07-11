// Barrel — re-exports every check KIND as a namespace so core.mjs imports `* as KINDS`
// and dispatches `KINDS[spec.kind].detect(...)`. Add a line here as each kind is built.
export * as forbiddenPattern from './forbiddenPattern.mjs';
export * as testShapeGuard from './testShapeGuard.mjs';
export * as magicLiteralGuard from './magicLiteralGuard.mjs';
export * as shadowOracleGuard from './shadowOracleGuard.mjs';
export * as derivationCoherence from './derivationCoherence.mjs';
export * as assertionConsistency from './assertionConsistency.mjs';
export * as weakOracleGuard from './weakOracleGuard.mjs';
export * as assertionFreeTest from './assertionFreeTest.mjs';
// selfComparisonOracle: measured CYCLE-10 — high base rate, ~zero defect yield; NOT promoted, and
// pulled from the adopter-facing floor (configure/gutcheck.default.json / checksets/python.mjs no
// longer register it). The kind module stays, reachable only via an explicit checker config.
// fallbackCollapse: PROMOTED to LINT_KINDS after CYCLE-10 corpus measurement (16 TRUE / 0 FP post-tightening).
export * as selfComparisonOracle from './selfComparisonOracle.mjs';
export * as fallbackCollapse from './fallbackCollapse.mjs';
