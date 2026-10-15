// ============================================================================
// OmniFlow — Entitlements (Free / Pro).
//
// A single, pure source of truth for which features are unlocked. Wired to
// the admin row `omniflow_user_tier` (set by the admin console); when the
// tier is 'free' (or unset) only the FREE features are available.
//
// This is the switch that the Lemon Squeezy checkout / Supabase DB will flip
// when a user upgrades to Pro. Until then, the flag defaults to 'free' so
// no feature is accidentally unlocked without payment.
// ============================================================================

export type Tier = 'free' | 'pro';

/** Features that are always available, on any tier. */
export const FREE_FEATURES = [
  'expenses',
  'manual-capture',
  'ocr-receipt',
  'pdf-statement-import',
  'csv-export-expenses',
  'csv-export-investments',
  'networth-snapshot',
  'rule-engine-advisor',
  'budgets',
  'recurring-bills',
  'debt-payoff',
  'cashflow-forecast',
  'emergency-reserve',
  'multi-currency',
] as const;

/** Features unlocked only when tier === 'pro'. */
export const PRO_FEATURES = [
  'llm-coach',
  'csv-export-pnl',
  'rebalance-alerts',
  'dividends',
  'savings-goals',
  'csv-import-extended',
] as const;

export interface Entitlements {
  tier: Tier;
  has: (feature: string) => boolean;
}

/**
 * Build the entitlement set for a given tier.
 * `has` returns true for any FREE feature on either tier, and for PRO
 * features only when `tier === 'pro'`.
 */
export function makeEntitlements(tier: Tier): Entitlements {
  const free = new Set<string>(FREE_FEATURES as readonly string[]);
  const pro = new Set<string>(PRO_FEATURES as readonly string[]);
  return {
    tier,
    has: (feature: string) => free.has(feature) || (tier === 'pro' && pro.has(feature)),
  };
}

/** Default tier when no row exists (safe: everything Pro is locked). */
export const DEFAULT_TIER: Tier = 'free';
