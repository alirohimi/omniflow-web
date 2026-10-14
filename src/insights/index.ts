// ============================================================================
// OmniFlow — insights module barrel.
// Pure, offline, $0 financial engines. Every function is deterministic given
// its inputs (no Date.now() inside — callers pass `now`), so they are fully
// unit-testable and feed the Insights/PWA/notification layers.
// ============================================================================

export * from './budgets';
export * from './debt';
export * from './networth';
export * from './forecast';
export * from './recurring';
export * from './rebalance';
export * from './dividends';
export * from './pnl';
export * from './emergency';
export * from './expenses';
