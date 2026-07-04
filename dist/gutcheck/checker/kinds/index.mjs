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
