// ============================================================================
// OmniFlow — Coach actions.
//
// The coach is grounded in the user's data and may PROPOSE changes. Every
// proposal is a strict [ACTION:{...}] marker that the client parses and
// validates against the real domain (enums, ISO currencies, sane numbers,
// targets that exist) before anything is shown. The user then confirms with
// Apply — nothing is written to the vault before that. Invalid or
// unverifiable proposals are rejected with a reason, never written. The
// rule-engine tier (no LLM key) never emits actions.
// ============================================================================

import type {
  AITier,
  AssetClass,
  Category,
  Expense,
  InvestmentAccount,
  InvestmentHolding,
  PaymentMethod,
} from '../domain/types';
import { fxService, type RatesForBase } from '../services/fx';

export const ACCOUNT_TYPES = ['broker', 'robo', 'crypto', 'cash', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ASSET_CLASSES: AssetClass[] = [
  'equity-us', 'equity-local', 'etf', 'crypto', 'cash', 'mmf',
];

export const PAYMENT_METHODS: PaymentMethod[] = [
  'card', 'qr', 'ewallet', 'cash', 'bank', 'other',
];

/** A holding inside a new portfolio (create_portfolio only). */
export interface ProposedHolding {
  symbol: string;
  assetClass: AssetClass;
  currency: string; // ISO 4217, the currency the holding is denominated in
  units: number;
  entryPrice: number; // average entry price, in `currency`
}

/** The original create_portfolio action (kept for tests/imports). */
export interface CreatePortfolioAction {
  action: 'create_portfolio';
  platformName: string;
  accountType: AccountType;
  holdings: ProposedHolding[];
}

/** Fields the LLM may set when editing an existing expense. At least one. */
export const EXPENSE_PATCH_FIELDS = [
  'amount', 'currency', 'category', 'merchant', 'paymentMethod', 'note', 'date',
] as const;
export type ExpensePatchField = (typeof EXPENSE_PATCH_FIELDS)[number];

/** Fields the LLM may set when adjusting an existing holding. At least one. */
export const HOLDING_PATCH_FIELDS = [
  'symbol', 'assetClass', 'currency', 'units', 'entryPrice',
] as const;
export type HoldingPatchField = (typeof HOLDING_PATCH_FIELDS)[number];

/** edit_expense — validated, LLM-safe patch. Field names match the store's
 *  editExpense() surface: 'amount' maps to originalAmount, 'date' to timestamp.
 *  Values are pre-validated (ISO currency uppercased, category resolved to an
 *  exact existing name, date resolved to epoch ms, paymentMethod enum-checked). */
export interface ExpensePatch {
  amount?: number;
  currency?: string;
  category?: string;
  merchant?: string;
  paymentMethod?: PaymentMethod;
  note?: string;
  /** Epoch ms; the parser resolves the LLM's ISO/"now" strings to this. */
  timestamp?: number;
}

/** holding_patch — validated, LLM-safe patch. Field names match the store's
 *  updateHolding() surface: 'currency' -> holdingCurrency, 'entryPrice' ->
 *  averageEntryPrice. symbol/assetClass/currency are string-typed because the
 *  parser normalizes them (upper-case ticker, enum-checked class, ISO code). */
export interface HoldingPatch {
  symbol?: string;
  assetClass?: AssetClass;
  currency?: string;
  units?: number;
  entryPrice?: number;
}

/** Every action the LLM may propose. The confirm card renders each kind. */
export type Action =
  | CreatePortfolioAction
  | {
      action: 'add_expense';
      amount: number;
      currency: string; // ISO 4217
      category: string; // an exact name from the user's category list
      merchant: string;
      paymentMethod: PaymentMethod;
      /** Epoch ms; the parser resolves the LLM's ISO/"now" to this. */
      timestamp: number;
      note?: string;
    }
  | {
      action: 'edit_expense';
      targetId: string; // Expense.id
      patches: ExpensePatch;
    }
  | {
      action: 'delete_expense';
      targetId: string; // Expense.id
    }
  | {
      action: 'holding_patch';
      targetId: string; // InvestmentHolding.id
      patches: HoldingPatch;
    };

export interface ActionValidation {
  ok: boolean;
  action?: Action;
  /** Human-readable rejection reason when ok === false. */
  reason?: string;
}

/**
 * Minimal store surface the appliers need (structural, test-friendly).
 * Reads go through getters so this can be satisfied by the real VaultStore
 * (where expenses/holdings live inside `vault`) without coupling to that
 * shape. Writes go through the store methods, which return ids.
 */
export interface ActionStore {
  // portfolio
  addAccount: (i: { platformName: string; accountType: InvestmentAccount['accountType'] }) => string;
  addHolding: (i: {
    accountId: string;
    symbol: string;
    assetClass: AssetClass;
    holdingCurrency: string;
    units: number;
    averageEntryPrice: number;
    currentPriceLocal?: number;
    currentPriceBase?: number;
  }) => string;
  getAccounts: () => InvestmentAccount[];
  getHoldings: () => InvestmentHolding[];
  // expenses
  addExpense: (i: {
    originalAmount: number;
    originalCurrency: string;
    fxRate: number;
    category: string;
    aiTier: AITier;
    merchant: string;
    paymentMethod: PaymentMethod;
    source: Expense['source'];
    note?: string;
    timestamp?: number;
  }) => string;
  editExpense: (
    id: string,
    patch: {
      originalAmount?: number;
      originalCurrency?: string;
      category?: string;
      merchant?: string;
      paymentMethod?: PaymentMethod;
      note?: string;
      timestamp?: number;
    },
  ) => void;
  deleteExpense: (id: string) => void;
  getExpenses: () => Expense[];
  getCategories: () => Category[];
  // holdings
  updateHolding: (id: string, patch: Partial<Omit<InvestmentHolding, 'id'>>) => void;
}

// ---------------------------------------------------------------------------
// Validation helpers (shared by the per-action parsers).
// ---------------------------------------------------------------------------

const MARKER_RE = /\[ACTION:(\{[\s\S]*\})\]/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

const isIsoCur = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Z]{3}$/.test(v.trim().toUpperCase());

const isCleanSymbol = (v: string): boolean => /^[A-Z0-9.\-@^_]+$/.test(v);

/** Parse an LLM-supplied timestamp: epoch ms, ISO string, or 'now'. */
function parseWhen(v: unknown, now: number): { ts: number; missing: boolean } {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return { ts: v, missing: false };
  if (typeof v === 'string' && v.trim().toLowerCase() === 'now') return { ts: now, missing: false };
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return { ts: t, missing: false };
  }
  return { ts: now, missing: true };
}

function parseCreatePortfolio(d: Record<string, unknown>): { action?: Action; reason?: string } {
  const platformName = typeof d.platformName === 'string' ? d.platformName.trim().slice(0, 40) : '';
  if (!platformName) return { reason: 'Missing platformName.' };

  const accountType = d.accountType;
  if (!(ACCOUNT_TYPES as readonly string[]).includes(String(accountType))) {
    return { reason: 'accountType must be one of: ' + ACCOUNT_TYPES.join(', ') + '.' };
  }

  const rawHoldings: unknown[] = Array.isArray(d.holdings) ? d.holdings : [];
  if (rawHoldings.length === 0) return { reason: 'At least one holding is required.' };
  if (rawHoldings.length > 20) return { reason: 'Too many holdings in one action (max 20).' };

  const holdings: ProposedHolding[] = [];
  const seen = new Set<string>();
  for (const h of rawHoldings) {
    const hh = h as Record<string, unknown>;
    const symbol = typeof hh.symbol === 'string' ? hh.symbol.trim().toUpperCase().slice(0, 16) : '';
    if (!symbol || !isCleanSymbol(symbol)) {
      return { reason: 'Invalid symbol: ' + String(hh.symbol ?? '') + '. Use a ticker like CSPX, BTC, AAPL, 1155.KL.' };
    }
    if (seen.has(symbol)) return { reason: 'Duplicate symbol in one action: ' + symbol + '.' };
    seen.add(symbol);

    if (!ASSET_CLASSES.includes(hh.assetClass as AssetClass)) {
      return { reason: 'Invalid assetClass for ' + symbol + ': ' + String(hh.assetClass) + '. Use one of: ' + ASSET_CLASSES.join(', ') + '.' };
    }
    if (!isIsoCur(hh.currency)) {
      return { reason: 'Invalid currency for ' + symbol + ': ' + String(hh.currency) + '. Use an ISO 4217 code like USD or MYR.' };
    }
    if (!isNum(hh.units) || hh.units <= 0) {
      return { reason: 'units for ' + symbol + ' must be a positive number.' };
    }
    if (!isNum(hh.entryPrice)) {
      return { reason: 'entryPrice for ' + symbol + ' must be a non-negative number.' };
    }
    holdings.push({
      symbol,
      assetClass: hh.assetClass as AssetClass,
      currency: (hh.currency as string).trim().toUpperCase(),
      units: hh.units,
      entryPrice: hh.entryPrice,
    });
  }

  return {
    action: {
      action: 'create_portfolio',
      platformName,
      accountType: accountType as AccountType,
      holdings,
    },
  };
}

function parseAddExpense(d: Record<string, unknown>, cats: Category[], now: number): { action?: Action; reason?: string } {
  if (!isNum(d.amount) || d.amount <= 0) return { reason: 'add_expense.amount must be a positive number.' };
  if (!isIsoCur(d.currency)) return { reason: 'add_expense.currency must be an ISO 4217 code like USD or MYR.' };

  const category = typeof d.category === 'string' ? d.category.trim() : '';
  if (!category) return { reason: 'add_expense.category is required. Pick one of the existing category names.' };
  if (!cats.some((c) => c.name.toLowerCase() === category.toLowerCase())) {
    return { reason: 'Unknown category: ' + category + '. Use one of: ' + cats.map((c) => c.name).join(', ') + '.' };
  }

  const merchant = typeof d.merchant === 'string' ? d.merchant.trim().slice(0, 60) : '';
  if (!merchant) return { reason: 'add_expense.merchant is required.' };

  if (!PAYMENT_METHODS.includes(d.paymentMethod as PaymentMethod)) {
    return { reason: 'add_expense.paymentMethod must be one of: ' + PAYMENT_METHODS.join(', ') + '.' };
  }

  const { ts, missing } = parseWhen(d.date, now);
  if (missing) return { reason: 'add_expense.date must be an ISO date-time string or "now".' };

  const note = typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 140) : undefined;

  return {
    action: {
      action: 'add_expense',
      amount: d.amount,
      currency: (d.currency as string).trim().toUpperCase(),
      category: cats.find((c) => c.name.toLowerCase() === category.toLowerCase())!.name,
      merchant,
      paymentMethod: d.paymentMethod as PaymentMethod,
      timestamp: ts,
      ...(note ? { note } : {}),
    },
  };
}

function parseEditExpense(d: Record<string, unknown>, cats: Category[], now: number): { action?: Action; reason?: string } {
  const targetId = typeof d.targetId === 'string' ? d.targetId.trim() : '';
  if (!targetId) return { reason: 'edit_expense.targetId is required (the id of the existing expense).' };

  const raw = (d.patches ?? (typeof d.fields === 'undefined' ? d : undefined)) as
    Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return { reason: 'edit_expense.patches is required.' };

  const fields = Array.isArray(d.fields) && d.fields.length > 0
    ? d.fields
    : (Object.keys(raw) as unknown[]);
  if (fields.length === 0) return { reason: 'edit_expense.patches has no fields to change.' };
  if (fields.length > 5) return { reason: 'Too many fields in one edit (max 5).' };

  // Build the domain-typed patch directly (not a wide LLM-keyed record) so it
  // satisfies ExpensePatch: amount is a number, currency a string, and the
  // LLM 'date' is resolved to a `timestamp` (epoch ms) here.
  const patches: ExpensePatch = {};
  for (const f of fields) {
    if (!(EXPENSE_PATCH_FIELDS as readonly string[]).includes(String(f))) {
      return { reason: 'Unknown expense field: ' + String(f) + '.' };
    }
    const key = f as ExpensePatchField;
    const v = raw[key];
    switch (key) {
      case 'amount': {
        if (!isNum(v) || v <= 0) return { reason: 'edit_expense.amount must be a positive number.' };
        patches.amount = v;
        break;
      }
      case 'date': {
        const { ts, missing } = parseWhen(v, now);
        if (missing) return { reason: 'edit_expense.date must be an ISO date-time string or "now".' };
        patches.timestamp = ts;
        break;
      }
      case 'currency': {
        if (!isIsoCur(v)) return { reason: 'edit_expense.currency must be an ISO 4217 code.' };
        patches.currency = (v as string).trim().toUpperCase();
        break;
      }
      case 'category': {
        const c = typeof v === 'string' ? (v as string).trim() : '';
        if (!cats.some((x) => x.name.toLowerCase() === c.toLowerCase())) {
          return { reason: 'Unknown category: ' + c + '.' };
        }
        patches.category = cats.find((x) => x.name.toLowerCase() === c.toLowerCase())!.name;
        break;
      }
      case 'merchant': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s) return { reason: 'edit_expense.merchant must be a non-empty string.' };
        patches.merchant = s.slice(0, 60);
        break;
      }
      case 'note': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s) return { reason: 'edit_expense.note must be a non-empty string.' };
        patches.note = s.slice(0, 140);
        break;
      }
      case 'paymentMethod': {
        if (!PAYMENT_METHODS.includes(v as PaymentMethod)) {
          return { reason: 'edit_expense.paymentMethod must be one of: ' + PAYMENT_METHODS.join(', ') + '.' };
        }
        patches.paymentMethod = v as PaymentMethod;
        break;
      }
    }
  }

  return { action: { action: 'edit_expense', targetId, patches } };
}

function parseDeleteExpense(d: Record<string, unknown>): { action?: Action; reason?: string } {
  const targetId = typeof d.targetId === 'string' ? d.targetId.trim() : '';
  if (!targetId) return { reason: 'delete_expense.targetId is required (the id of the expense to remove).' };
  return { action: { action: 'delete_expense', targetId } };
}

function parseHoldingPatch(d: Record<string, unknown>): { action?: Action; reason?: string } {
  const targetId = typeof d.targetId === 'string' ? d.targetId.trim() : '';
  if (!targetId) return { reason: 'holding_patch.targetId is required (the id of the existing holding).' };

  const raw = (d.patches ?? (typeof d.fields === 'undefined' ? d : undefined)) as
    Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return { reason: 'holding_patch.patches is required.' };

  const fields = Array.isArray(d.fields) && d.fields.length > 0
    ? d.fields
    : (Object.keys(raw) as unknown[]);
  if (fields.length === 0) return { reason: 'holding_patch.patches has no fields to change.' };
  if (fields.length > 4) return { reason: 'Too many fields in one holding patch (max 4).' };

  // Build the domain-typed HoldingPatch directly (not a wide LLM-keyed record)
  // so it satisfies the type: units/entryPrice are numbers, symbol/assetClass/
  // currency strings (assetClass enum-checked, currency ISO-normalized).
  const patches: HoldingPatch = {};
  for (const f of fields) {
    if (!(HOLDING_PATCH_FIELDS as readonly string[]).includes(String(f))) {
      return { reason: 'Unknown holding field: ' + String(f) + '.' };
    }
    const key = f as HoldingPatchField;
    const v = raw[key];
    switch (key) {
      case 'units':
      case 'entryPrice': {
        if (!isNum(v) || (key === 'units' && v <= 0)) return { reason: 'holding_patch.' + key + ' must be a positive number.' };
        patches[key] = v;
        break;
      }
      case 'symbol': {
        const s = typeof v === 'string' ? v.trim().toUpperCase().slice(0, 16) : '';
        if (!s || !isCleanSymbol(s)) return { reason: 'holding_patch.symbol must be a clean ticker like CSPX, BTC, AAPL.' };
        patches.symbol = s;
        break;
      }
      case 'assetClass': {
        if (!ASSET_CLASSES.includes(v as AssetClass)) {
          return { reason: 'holding_patch.assetClass must be one of: ' + ASSET_CLASSES.join(', ') + '.' };
        }
        patches.assetClass = v as AssetClass;
        break;
      }
      case 'currency': {
        if (!isIsoCur(v)) return { reason: 'holding_patch.currency must be an ISO 4217 code.' };
        patches.currency = (v as string).trim().toUpperCase();
        break;
      }
    }
  }

  return { action: { action: 'holding_patch', targetId, patches } };
}

/** Parse + validate an [ACTION:...] marker against the live domain.
 *  `now` is injectable for tests; defaults to Date.now(). */
export function parseAction(raw: string, cats: Category[] = [], now: number = Date.now()): ActionValidation {
  const m = MARKER_RE.exec(raw);
  if (!m) return { ok: false, reason: 'No [ACTION:] marker found.' };

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, reason: 'Invalid JSON in action marker: ' + String(e).slice(0, 80) };
  }

  const d = data as Record<string, unknown>;
  let out: { action?: Action; reason?: string };
  switch (d?.action) {
    case 'create_portfolio':
      out = parseCreatePortfolio(d);
      break;
    case 'add_expense':
      out = parseAddExpense(d, cats, now);
      break;
    case 'edit_expense':
      out = parseEditExpense(d, cats, now);
      break;
    case 'delete_expense':
      out = parseDeleteExpense(d);
      break;
    case 'holding_patch':
      out = parseHoldingPatch(d);
      break;
    default:
      return { ok: false, reason: 'Unknown action type: ' + String(d?.action ?? '') };
  }

  if (out.reason !== undefined) return { ok: false, reason: out.reason };
  if (out.action === undefined) return { ok: false, reason: 'Action incomplete.' };
  return { ok: true, action: out.action };
}

/** Remove the marker from user-visible text. */
export function stripActionMarker(text: string): string {
  return text.replace(MARKER_RE, '').trim();
}

// ---------------------------------------------------------------------------
// Apply — idempotent where possible. Reads targets off the store, writes
// through the store methods (which persist + sync the vault). Returns a
// short human summary for the confirm-result line.
// ---------------------------------------------------------------------------

/**
 * Apply a validated action through the store. Idempotent where possible
 * (a re-apply of the same add_expense is skipped; edits/deletes of a
 * missing target are a no-op). `fx` — the caller's live rate table, when
 * one is available — lets add_expense store a real base-currency rate
 * instead of the offline-safe 1. Returns a short human summary for the
 * confirm-result line.
 */
export function applyAction(store: ActionStore, a: Action, fx?: RatesForBase): string {
  switch (a.action) {
    case 'create_portfolio':
      return applyCreatePortfolio(store, a);

    case 'add_expense': {
      // Idempotence: the same spend (merchant + amount + currency + category
      // + timestamp) already logged is skipped, not duplicated.
      const dup = store.getExpenses().some(
        (e) =>
          e.merchant === a.merchant &&
          e.originalAmount === a.amount &&
          e.originalCurrency === a.currency &&
          e.category === a.category &&
          e.timestamp === a.timestamp,
      );
      if (dup) return 'that expense is already logged — nothing was added.';

      // Real FX rate when the caller has a live table for this base; fall
      // back to 1 (same-currency / offline) — the stored base value is then
      // best-effort, matching the expense pipeline's offline behaviour.
      let fxRate = 1;
      if (fx && a.currency !== fx.base) {
        const r = fxService.toBase(1, a.currency, fx);
        if (Number.isFinite(r) && r > 0) fxRate = r;
      }
      const id = store.addExpense({
        originalAmount: a.amount,
        originalCurrency: a.currency,
        fxRate,
        category: a.category,
        aiTier: 'llm-byok',
        merchant: a.merchant,
        paymentMethod: a.paymentMethod,
        source: 'manual',
        ...(a.note ? { note: a.note } : {}),
        timestamp: a.timestamp,
      });
      return 'added expense ' + id;
    }

    case 'edit_expense': {
      if (!store.getExpenses().some((e) => e.id === a.targetId)) {
        return 'expense ' + a.targetId + ' no longer exists — nothing changed.';
      }
      // The action carries LLM-facing field names; the store speaks the
      // domain shape. Translate here — never pass LLM keys straight in.
      const p = a.patches;
      store.editExpense(a.targetId, {
        ...(p.amount !== undefined ? { originalAmount: p.amount } : {}),
        ...(p.currency !== undefined ? { originalCurrency: p.currency } : {}),
        ...(p.category !== undefined ? { category: p.category } : {}),
        ...(p.merchant !== undefined ? { merchant: p.merchant } : {}),
        ...(p.paymentMethod !== undefined ? { paymentMethod: p.paymentMethod } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
        ...(p.timestamp !== undefined ? { timestamp: p.timestamp } : {}),
      });
      return 'updated expense ' + a.targetId + ' (' + Object.keys(p).join(', ') + ')';
    }

    case 'delete_expense': {
      if (!store.getExpenses().some((e) => e.id === a.targetId)) {
        return 'expense ' + a.targetId + ' no longer exists — nothing deleted.';
      }
      store.deleteExpense(a.targetId);
      return 'deleted expense ' + a.targetId;
    }

    case 'holding_patch': {
      const h = store.getHoldings().find((x) => x.id === a.targetId);
      if (!h) return 'holding ' + a.targetId + ' no longer exists — nothing changed.';
      store.updateHolding(a.targetId, {
        ...(a.patches.symbol !== undefined ? { symbol: a.patches.symbol } : {}),
        ...(a.patches.assetClass !== undefined ? { assetClass: a.patches.assetClass } : {}),
        ...(a.patches.currency !== undefined ? { holdingCurrency: a.patches.currency } : {}),
        ...(a.patches.units !== undefined ? { units: a.patches.units } : {}),
        ...(a.patches.entryPrice !== undefined ? { averageEntryPrice: a.patches.entryPrice } : {}),
      });
      return 'updated holding ' + h.symbol + ' (' + Object.keys(a.patches).join(', ') + ')';
    }
  }
}

/** The single pre-LLM-action path, kept for the original create_portfolio
 *  flow (and its tests): dedupe against an existing same-named account and
 *  skip duplicate holdings. */
export function applyCreatePortfolio(store: ActionStore, a: CreatePortfolioAction): string {
  const accounts = store.getAccounts();
  const holdings = store.getHoldings();
  const existing = accounts.find((x) => x.platformName.toLowerCase() === a.platformName.toLowerCase());
  const accountId = existing ? existing.id : store.addAccount({ platformName: a.platformName, accountType: a.accountType });

  let added = 0;
  let skipped = 0;
  for (const h of a.holdings) {
    const dup = holdings.some(
      (x) => x.accountId === accountId && x.symbol === h.symbol && x.units === h.units && x.averageEntryPrice === h.entryPrice,
    );
    if (dup) { skipped++; continue; }
    store.addHolding({
      accountId,
      symbol: h.symbol,
      assetClass: h.assetClass,
      holdingCurrency: h.currency,
      units: h.units,
      averageEntryPrice: h.entryPrice,
    });
    added++;
  }

  const bits: string[] = [];
  bits.push(existing ? 'used existing "' + existing.platformName + '"' : 'created "' + a.platformName + '" (' + a.accountType + ')');
  if (added > 0) bits.push('added ' + added + ' holding' + (added === 1 ? '' : 's'));
  if (skipped > 0) bits.push('skipped ' + skipped + ' duplicate' + (skipped === 1 ? '' : 's'));
  return bits.join(', ');
}

// ---------------------------------------------------------------------------
// Prompt contract — appended to the coach system prompt. The LLM may ONLY
// emit markers when the user explicitly asks to change data; every proposal
// is validated + confirmed client-side before anything is written.
// ---------------------------------------------------------------------------

export const ACTION_CONTRACT: string = [
  '',
  'You may also ACT on the user\'s data. When — and ONLY when — the user explicitly asks to create, log, add, edit, adjust, or delete expenses or holdings, reply with a short plain-language confirmation of exactly what you will do, followed on its own line by exactly one marker of the form [ACTION:{...}] with one of these strict shapes:',
  '',
  '1. NEW SPEND — [ACTION:{"action":"add_expense","amount":<number>,"currency":"<ISO code>","category":"<one of the user\'s existing categories>","merchant":"<name>","paymentMethod":"<one of: card|qr|ewallet|cash|bank|other>","date":"<ISO date-time or "now">"}]',
  '2. EDIT SPEND — [ACTION:{"action":"edit_expense","targetId":"<the expense id from the data snapshot>","patches":{"<field>":<value>}}] where field is one of: amount(number) | currency(ISO) | category(existing name) | merchant(string) | paymentMethod(enum) | note(string) | date(ISO or "now")',
  '3. DELETE SPEND — [ACTION:{"action":"delete_expense","targetId":"<the expense id from the data snapshot>"}]',
  '4. ADJUST A HOLDING — [ACTION:{"action":"holding_patch","targetId":"<the holding id from the data snapshot>","patches":{"<field>":<value>}}] where field is one of: units(number) | entryPrice(number) | symbol(ticker) | assetClass(enum) | currency(ISO)',
  '5. NEW PORTFOLIO — [ACTION:{"action":"create_portfolio","platformName":"<name>","accountType":"<one of: broker|robo|crypto|cash|other>","holdings":[{"symbol":"<ticker>","assetClass":"<one of: equity-us|equity-local|etf|crypto|cash|mmf>","currency":"<ISO>","units":<number>,"entryPrice":<number>}]}]',
  '',
  'Rules for every marker: valid JSON only; numbers as numbers (no quotes); use the ids exactly as listed in the data snapshot (recentExpenses / openHoldings). For edits and deletes you MUST reference an existing id from the snapshot — never invent one. When the user\'s request is ambiguous (which expense? which holding?), ask ONE clarifying question instead of guessing. Never emit [ACTION:] for analysis, questions, or advice about data that already exists. One marker per reply.',
].join('\n');

export const __test = {
  parseAction,
  stripActionMarker,
  applyAction,
  applyCreatePortfolio,
  ACCOUNT_TYPES,
  ASSET_CLASSES,
  PAYMENT_METHODS,
  EXPENSE_PATCH_FIELDS,
  HOLDING_PATCH_FIELDS,
  ACTION_CONTRACT,
};
