import type {
  AutoInvestPeriod,
  BudgetPeriod,
  Category,
  EmergencyFundItem,
  ManualAsset,
  ParsedStatementLine,
  PendingImport,
  UserPreferences,
  VaultBlob,
} from './types';
import { DEFAULT_PREFS, CATEGORIES, BUDGET_PERIODS, ASSET_KINDS, EMERGENCY_DEFAULT, AUTO_INVEST_PERIODS } from './enums';

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
    budgets: [],
    recurring: [],
    liabilities: [],
    assets: [],
    dividends: [],
    disposals: [],
    emergency: { ...EMERGENCY_DEFAULT, items: [] },
    netWorthHistory: [],
    savingsGoals: [],
    autoInvests: [],
    contributions: [],
    pendingImport: null,
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
      initialDepositBase:
        typeof a.initialDepositBase === 'number' && Number.isFinite(a.initialDepositBase) && a.initialDepositBase > 0
          ? a.initialDepositBase
          : undefined,
    };
  });

  if (!Array.isArray(blob.categories)) blob.categories = [];
  if (typeof blob.llmKey !== 'string') blob.llmKey = '';
  if (!blob.prefs) blob.prefs = { ...DEFAULT_PREFS };
  // New prefs fields: prefill required ones (billReminders) + safe optionals
  // (billNoticeWindowDays) on old blobs so the Insights + notifications code
  // never sees undefined where it expects a boolean/number.
  if (typeof blob.prefs.billReminders !== 'boolean') blob.prefs.billReminders = false;
  if (typeof blob.prefs.billNoticeWindowDays !== 'number') blob.prefs.billNoticeWindowDays = DEFAULT_PREFS.billNoticeWindowDays ?? 3;
  // New entity collections: safe empty arrays so old encrypted blobs keep
  // working and no reader has to ?? [] everywhere.
  if (!Array.isArray(blob.budgets)) blob.budgets = [];
  if (!Array.isArray(blob.recurring)) blob.recurring = [];
  if (!Array.isArray(blob.liabilities)) blob.liabilities = [];
  if (!Array.isArray(blob.assets)) blob.assets = [];
  if (!Array.isArray(blob.dividends)) blob.dividends = [];
  if (!Array.isArray(blob.disposals)) blob.disposals = [];
  if (!Array.isArray(blob.netWorthHistory)) blob.netWorthHistory = [];
  if (!Array.isArray(blob.savingsGoals)) blob.savingsGoals = [];
  // Emergency module: prefill from the default on old blobs so the
  // dashboard + coach always see a well-shaped module, then per-row guards
  // (best-effort; never drop user data).
  if (!blob.emergency || typeof blob.emergency !== 'object') blob.emergency = { ...EMERGENCY_DEFAULT, items: [] };
  if (!Array.isArray(blob.emergency.items)) blob.emergency.items = [];
  // One-time upgrade: vaults created under the OLD 3-month rule carry a
  // baked-in targetMonths of 3 that the engine would otherwise "respect"
  // (treating it as a deliberate user choice), so the new 6-month default
  // never took effect for existing users. 3 was the legacy DEFAULT, not a
  // picked value, so we upgrade it to the new default. Any OTHER value
  // (4..12, set from the panel's 1-12 picker) is a deliberate choice and is
  // left untouched.
  if (blob.emergency.targetMonths === 3) blob.emergency.targetMonths = EMERGENCY_DEFAULT.targetMonths;
  if (typeof blob.emergency.targetMonths !== 'number' || !Number.isFinite(blob.emergency.targetMonths) || blob.emergency.targetMonths < 1) {
    blob.emergency.targetMonths = EMERGENCY_DEFAULT.targetMonths;
  }
  blob.emergency = { ...blob.emergency, targetMonths: Math.round(blob.emergency.targetMonths) };
  if (!Array.isArray(blob.autoInvests)) blob.autoInvests = [];
  if (!Array.isArray(blob.contributions)) blob.contributions = [];
  // Per-row shape guards for the auto-invest plans + contribution ledger.
  blob.autoInvests = blob.autoInvests.map((p) =>
    p && typeof p === 'object'
      ? {
          ...p,
          accountId: typeof p.accountId === 'string' ? p.accountId : '',
          name: typeof p.name === 'string' ? p.name : '',
          amount: num(p.amount, 0),
          currency: typeof p.currency === 'string' ? p.currency : '',
          baseAmount: num(p.baseAmount, 0),
          fxRate: p.fxRate === undefined ? 1 : num(p.fxRate, 1),
          period: AUTO_INVEST_PERIODS.includes((p as { period: AutoInvestPeriod }).period)
            ? (p as { period: AutoInvestPeriod }).period
            : 'monthly',
          nextDue: num(p.nextDue, Date.now()),
          active: typeof p.active === 'boolean' ? p.active : true,
          createdAt: num(p.createdAt, Date.now()),
        }
      : p,
  );
  blob.contributions = blob.contributions.map((c) =>
    c && typeof c === 'object'
      ? {
          ...c,
          accountId: typeof c.accountId === 'string' ? c.accountId : '',
          amount: num(c.amount, 0),
          currency: typeof c.currency === 'string' ? c.currency : '',
          amountBase: num(c.amountBase, 0),
          fxRate: c.fxRate === undefined ? 1 : num(c.fxRate, 1),
          date: num(c.date, Date.now()),
        }
      : c,
  );
  // Net-worth history: normalize to an array (old blobs may lack it).
  if (!Array.isArray(blob.netWorthHistory)) blob.netWorthHistory = [];
  // Per-row shape guards (best-effort; never drop user data).
  blob.recurring = blob.recurring.map((r) =>
    r && typeof r === 'object'
      ? {
          ...r,
          name: typeof r.name === 'string' ? r.name : '',
          merchant: typeof r.merchant === 'string' ? r.merchant : '',
          amount: num(r.amount, 0),
          currency: typeof r.currency === 'string' ? r.currency : '',
          baseAmount: num(r.baseAmount, num(r.amount, 0)),
          fxRate: r.fxRate === undefined ? 1 : num(r.fxRate, 1),
          period: BUDGET_PERIODS.includes((r as { period: BudgetPeriod }).period) ? (r as { period: BudgetPeriod }).period : 'monthly',
          nextDue: num(r.nextDue, Date.now()),
          category: typeof r.category === 'string' ? r.category : '',
          active: typeof r.active === 'boolean' ? r.active : true,
        }
      : r,
  );
  blob.liabilities = blob.liabilities.map((l) =>
    l && typeof l === 'object'
      ? {
          ...l,
          name: typeof l.name === 'string' ? l.name : '',
          balance: num(l.balance, 0),
          apr: num(l.apr, 0),
          minPayment: num(l.minPayment, 0),
          extraPayment: l.extraPayment === undefined ? undefined : num(l.extraPayment, 0),
        }
      : l,
  );
  blob.assets = blob.assets.map((a) =>
    a && typeof a === 'object'
      ? {
          ...a,
          name: typeof a.name === 'string' ? a.name : '',
          value: num(a.value, 0),
          kind: ASSET_KINDS.includes((a as { kind: ManualAsset['kind'] }).kind) ? (a as { kind: ManualAsset['kind'] }).kind : 'other',
        }
      : a,
  );
  blob.dividends = blob.dividends.map((d) =>
    d && typeof d === 'object'
      ? {
          ...d,
          holdingId: typeof d.holdingId === 'string' ? d.holdingId : '',
          symbol: typeof d.symbol === 'string' ? d.symbol : '',
          amount: num(d.amount, 0),
          currency: typeof d.currency === 'string' ? d.currency : '',
          date: num(d.date, Date.now()),
          reinvested: typeof d.reinvested === 'boolean' ? d.reinvested : false,
        }
      : d,
  );
  blob.disposals = blob.disposals.map((d) =>
    d && typeof d === 'object'
      ? {
          ...d,
          holdingId: typeof d.holdingId === 'string' ? d.holdingId : '',
          symbol: typeof d.symbol === 'string' ? d.symbol : '',
          units: num(d.units, 0),
          salePrice: num(d.salePrice, 0),
          currency: typeof d.currency === 'string' ? d.currency : '',
          costBasisPerUnit: num(d.costBasisPerUnit, 0),
          date: num(d.date, Date.now()),
        }
      : d,
  );
  blob.budgets = blob.budgets.map((b) =>
    b && typeof b === 'object'
      ? {
          ...b,
          category: typeof b.category === 'string' ? b.category : '',
          cap: num(b.cap, 0),
          period: BUDGET_PERIODS.includes((b as { period: BudgetPeriod }).period) ? (b as { period: BudgetPeriod }).period : 'monthly',
          rollover: typeof b.rollover === 'boolean' ? b.rollover : false,
          createdAt: num(b.createdAt, Date.now()),
        }
      : b,
  );
  blob.emergency!.items = blob.emergency!.items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const kind: 'manual' | 'account' =
      (it as { kind?: unknown }).kind === 'manual' ? 'manual' : 'account';
    const id: string =
      typeof (it as { id?: unknown }).id === 'string' ? (it as { id: string }).id : `e-${Math.random().toString(36).slice(2, 8)}`;
    // account items: keep the reference (string), drop a stale manual amount;
    // manual items: keep the amount (finite), clear a dangling accountId.
    const accountId: string | undefined =
      kind === 'manual'
        ? undefined
        : typeof (it as { accountId?: unknown }).accountId === 'string'
          ? (it as { accountId: string }).accountId
          : '';
    const amount: number | undefined =
      kind === 'manual'
        ? (typeof (it as { amount?: unknown }).amount === 'number' &&
            Number.isFinite((it as { amount: number }).amount)
            ? (it as { amount: number }).amount
            : 0)
        : undefined;
    return {
      id,
      kind,
      name:
        typeof (it as { name?: unknown }).name === 'string'
          ? (it as { name: string }).name
          : '',
      currency:
        typeof (it as { currency?: unknown }).currency === 'string'
          ? (it as { currency: string }).currency
          : '',
      createdAt: num((it as { createdAt?: unknown }).createdAt, Date.now()),
      accountId,
      amount,
    } as EmergencyFundItem;
  });
  // PendingImport (in-flight PDF statement import): heal to a well-shaped
  // object or null so a refresh rehydrates it cleanly. Per-row guards mirror
  // the ParsedStatementLine shape; best-effort, never drops user data.
  if (blob.pendingImport && typeof blob.pendingImport === 'object') {
    const p = blob.pendingImport;
    const lines: ParsedStatementLine[] = (Array.isArray(p.lines) ? p.lines : [])
      .filter((l): l is ParsedStatementLine => !!l && typeof l === 'object')
      .map((l) => ({
        raw: typeof l.raw === 'string' ? l.raw : '',
        date: typeof l.date === 'number' && Number.isFinite(l.date) ? l.date : undefined,
        merchant: typeof l.merchant === 'string' ? l.merchant : '',
        description: typeof l.description === 'string' ? l.description : undefined,
        amount: num(l.amount, 0),
        direction: l.direction === 'in' ? 'in' : 'out',
        currency: typeof l.currency === 'string' ? l.currency : undefined,
        category: typeof l.category === 'string' ? l.category : undefined,
        aiTier:
          l.aiTier === 'dictionary' || l.aiTier === 'llm-byok' || l.aiTier === 'llm-failed'
            ? l.aiTier
            : 'dictionary',
      }));
    // phase: 'parse' when we still hold raw text but no derived rows yet;
    // 'review' once lines exist. Prefer the persisted value, but fall back to
    // what the data actually contains so a half-written blob heals sanely.
    const hasText = typeof p.text === 'string' && (p.text as string).length > 0;
    const phase: PendingImport['phase'] =
      p.phase === 'parse' ? 'parse' : p.phase === 'review' ? 'review' : lines.length > 0 ? 'review' : hasText ? 'parse' : 'review';
    // Keep the raw text only when it's a string; cap it so a pathological
    // statement can't bloat the encrypted blob (the UI re-parses from this).
    const text = hasText ? (p.text as string).slice(0, 400_000) : undefined;
    const healed: PendingImport = {
      fileName: typeof p.fileName === 'string' ? p.fileName : '',
      phase,
      text,
      parser: p.parser === 'llm' ? 'llm' : 'regex',
      llmError: typeof p.llmError === 'string' ? p.llmError : undefined,
      lines,
      disabled: Array.isArray(p.disabled) ? p.disabled.filter((d) => typeof d === 'number') : [],
      createdAt: num(p.createdAt, Date.now()),
    };
    // A parse-phase checkpoint with no text yet (or review with no rows) has
    // nothing worth rehydrating -> drop it. Otherwise keep the healed object.
    blob.pendingImport = healed.lines.length === 0 && !healed.text ? null : healed;
  } else if (blob.pendingImport !== undefined) {
    blob.pendingImport = null;
  }
  if (blob.coachLog !== undefined && !Array.isArray(blob.coachLog)) delete blob.coachLog;
  return { blob, changed: JSON.stringify(blob) !== before };
}
