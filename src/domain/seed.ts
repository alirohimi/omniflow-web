import type {
  Category,
  UserPreferences,
  VaultBlob,
} from './types';
import { DEFAULT_PREFS, CATEGORIES } from './enums';

/** Fresh, empty vault (used on first launch before any data is entered). */
export function emptyVault(prefs?: Partial<UserPreferences>): VaultBlob {
  const now = Date.now();
  return {
    schema: 1,
    createdAt: now,
    updatedAt: now,
    expenses: [],
    categories: CATEGORIES,
    accounts: [],
    holdings: [],
    prefs: { ...DEFAULT_PREFS, ...prefs },
    llmKey: '',
  };
}

// ============================================================================
// Vault healing (white-screen defence, run on every decrypt).
//
// Historical bugs (addHolding spreading `...input` AFTER price defaults;
// updateHolding merging explicit `undefined` keys) persisted corrupt
// holding rows into the cloud vault. A decrypt that returns those rows
// crashes the whole app at render time (`undefined.toFixed`). healVault
// repairs each row best-effort — never dropping user data — so the app
// renders and the next persist writes the cleaned blob back to the DB:
//   * holdings: non-finite averageEntryPrice -> 0; undefined prices ->
//     entry price (the pre-clobber default the store computed); undefined
//     units/accountId -> safe zeros; cash/mmf rows get a par price (1)
//     because they have no live-quote path.
//   * expenses: undefined baseAmount -> originalAmount * fxRate; undefined
//     fxRate -> 1 (same-currency assumption); undefined timestamp -> now.
// ============================================================================

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Strip undefined values from an object so a spread merge can never
 *  clobber existing fields with `undefined` (the addHolding/updateHolding
 *  white-screen bug was exactly this: explicit `undefined` keys after the
 *  defaults). Exported for tests. */
export function withoutUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Repair a decrypted vault blob in place and report whether anything was
 *  changed (a changed blob should be re-persisted so the cleaned version
 *  wins in the DB on the next save). Callers keep their existing
 *  `decryptVault<T>` flow. */
export function healVault(blob: VaultBlob): { blob: VaultBlob; changed: boolean } {
  const before = JSON.stringify(blob);

  blob.holdings = (Array.isArray(blob.holdings) ? blob.holdings : []).map((h) => {
    if (!h || typeof h !== 'object') return h;
    const entry = num(h.averageEntryPrice, 0);
    const units = num(h.units, 0);
    const isCashish = h.assetClass === 'cash' || h.assetClass === 'mmf';
    // Price defaults: what addHolding computed pre-clobber (entry price in
    // both currencies; cash/mmf value at par, matching the quote service).
    const defaultPrice = isCashish ? 1 : entry;
    return {
      ...h,
      accountId: typeof h.accountId === 'string' ? h.accountId : '',
      symbol: typeof h.symbol === 'string' ? h.symbol : '',
      assetClass: h.assetClass,
      holdingCurrency: typeof h.holdingCurrency === 'string' ? h.holdingCurrency : '',
      units,
      averageEntryPrice: entry,
      currentPriceLocal: h.currentPriceLocal === undefined ? defaultPrice : num(h.currentPriceLocal, defaultPrice),
      currentPriceBase: h.currentPriceBase === undefined ? defaultPrice : num(h.currentPriceBase, defaultPrice),
    };
  });

  blob.expenses = (Array.isArray(blob.expenses) ? blob.expenses : []).map((e) => {
    if (!e || typeof e !== 'object') return e;
    const orig = num(e.originalAmount, 0);
    const fx = e.fxRate === undefined ? 1 : num(e.fxRate, 1);
    return {
      ...e,
      originalAmount: orig,
      fxRate: fx,
      baseAmount: e.baseAmount === undefined ? orig * fx : num(e.baseAmount, orig * fx),
      timestamp: typeof e.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : Date.now(),
      baseCurrency: typeof e.baseCurrency === 'string' ? e.baseCurrency : '',
    };
  });

  blob.accounts = (Array.isArray(blob.accounts) ? blob.accounts : []).map((a) => {
    if (!a || typeof a !== 'object') return a;
    return {
      ...a,
      platformName: typeof a.platformName === 'string' ? a.platformName : '',
      baseCurrencyValue: num(a.baseCurrencyValue, 0),
      lastUpdated: num(a.lastUpdated, Date.now()),
    };
  });

  if (!Array.isArray(blob.categories)) blob.categories = [];
  if (typeof blob.llmKey !== 'string') blob.llmKey = '';
  if (!blob.prefs) blob.prefs = { ...DEFAULT_PREFS };
  if (blob.coachLog !== undefined && !Array.isArray(blob.coachLog)) delete blob.coachLog;
  return { blob, changed: JSON.stringify(blob) !== before };
}
