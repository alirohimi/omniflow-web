// ============================================================================
// Investments — platform-agnostic portfolio view + holding CRUD.
// Grouped by platformName, with live quotes and FX-converted base values.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { Disclosure } from '../components/Disclosure';
import { Modal } from '../components/Sheet';
import { EmergencyPanel } from './EmergencyPanel';
import { SavingsGoalsPanel } from './SavingsGoalsPanel';
import { AutoInvestPanel, ContributionPanel } from './AutoInvestPanel';
import { AllocationPie, type PieSlice } from '../components/AllocationPie';
import { colorForClass } from '../components/AllocationPie';
import { fxService } from '../services';
import {
  portfolioPnl,
  dueAutoInvests,
  advanceNextDue,
  periodsBetween,
  autoInvestMonthlyTotal,
} from '../insights';
import { valueInBase } from '../ai/portfolio';
import type { AccountLine } from '../ai/portfolio';
import { CURRENCIES, currencyInfo, formatMoney, FAMED_STRATEGIES } from '../domain/enums';
import { ThemedSelect } from '../components/ThemedSelect';
import { IRefresh, IPlus, IPencil, IDots, ICheck } from '../icons';
import type { InvestmentAccount, InvestmentHolding } from '../domain/types';

const ASSET_CLASSES = ['equity-us', 'equity-local', 'etf', 'crypto', 'gold', 'cash', 'mmf'] as const;
/** Cash / MMF rows: single "amount" input, symbol + price pinned to the par
 *  convention (symbol = class name, price = 1) so value = amount · FX. */
const PAR_CLASSES: InvestmentHolding['assetClass'][] = ['cash', 'mmf'];
const isParClass = (c: InvestmentHolding['assetClass']) => PAR_CLASSES.includes(c);
/** Pinned symbol for par rows — matches the marketData par-price path. */
const parSymbolFor = (c: InvestmentHolding['assetClass']) =>
  c === 'cash' ? 'CASH' : c === 'mmf' ? 'MMF' : c.toUpperCase();

export function InvestmentsView() {
  const store = useVaultStore();
  const live = useLiveData();
  const { toast } = useToast();
  const { vault } = store;
  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const sym = currencyInfo(base).symbol;

  // ---- account + holding form state
  const [platform, setPlatform] = useState('');
  const [acctType, setAcctType] = useState<InvestmentAccount['accountType']>('broker');
  const [deposit, setDeposit] = useState('');
  const [accountId, setAccountId] = useState('');
  const [symbol, setSymbol] = useState('');
  const [assetClass, setAssetClass] = useState<InvestmentHolding['assetClass']>('equity-us');
  const [holdCur, setHoldCur] = useState(base);
  const [units, setUnits] = useState('');
  const [entry, setEntry] = useState('');
  /** Cash/MMF rows: a single "amount in holding currency" input (price pinned
   *  to par=1, symbol pinned to the class). Non-par rows ignore this. */
  const [amount, setAmount] = useState('');
  /** The holding (with its current values) being edited in the modal pop-up. */
  const [editHolding, setEditHolding] = useState<InvestmentHolding | null>(null);
  const parMode = isParClass(assetClass);

  const startEdit = (h: InvestmentHolding) => {
    openEdit(h);
  };

  /** Keep symbol pinned for par classes; clear it back to free entry otherwise. */
  const pickAssetClass = (c: InvestmentHolding['assetClass']) => {
    setAssetClass(c);
    if (isParClass(c)) setSymbol(parSymbolFor(c));
  };

  const [activePie, setActivePie] = useState<'class' | 'holding'>('class');

  // Pie slices: one per asset class (or per holding), each carrying the
  // individual holdings inside it for the drill-down. Reuses valueInBase so
  // the chart reconciles with the per-row list below (same NaN-safe math).
  const pieSlices = useMemo<PieSlice[]>(() => {
    if (!live.portfolio) return [];
    const rateToBaseLocal = (code: string): number =>
      live.fx ? fxService.toBase(1, code, live.fx) : code === base ? 1 : 0;
    if (activePie === 'holding') {
      return vault.holdings
        .map((h) => {
          const q = live.quotes[h.symbol];
          const { valueBase, ok } = valueInBase(h, q, base, rateToBaseLocal);
          return {
            key: h.id,
            label: h.symbol,
            valueBase: ok ? valueBase : 0,
            color: colorForClass(h.assetClass, 0),
          };
        })
        .filter((s) => s.valueBase > 0);
    }
    // Per class: group holdings, sum their base values, attach sub-breakdown.
    const byClass = new Map<string, { valueBase: number; sub: { label: string; valueBase: number }[] }>();
    for (const h of vault.holdings) {
      const q = live.quotes[h.symbol];
      const { valueBase, ok } = valueInBase(h, q, base, rateToBaseLocal);
      const v = ok ? valueBase : 0;
      const row = byClass.get(h.assetClass) ?? { valueBase: 0, sub: [] };
      row.valueBase += v;
      row.sub.push({ label: h.symbol, valueBase: v });
      byClass.set(h.assetClass, row);
    }
    return [...byClass.entries()]
      .filter(([, v]) => v.valueBase > 0)
      .map(([cls, v]) => ({
        key: cls,
        label: cls,
        valueBase: v.valueBase,
        color: colorForClass(cls, 0),
        sub: v.sub,
      }));
  }, [activePie, vault.holdings, live.quotes, live.fx, base]);

  const totalPieValue = useMemo(() => pieSlices.reduce((s, x) => s + x.valueBase, 0), [pieSlices]);

  const grouped = useMemo(() => {
    const byPlat = new Map<string, InvestmentHolding[]>();
    for (const h of vault.holdings) {
      const acc = vault.accounts.find((a) => a.id === h.accountId);
      const key = acc?.platformName ?? 'Unassigned';
      byPlat.set(key, [...(byPlat.get(key) ?? []), h]);
    }
    return byPlat;
  }, [vault.holdings, vault.accounts]);

  /** NaN-safe per-row valuation shared by the KPI panel and the holdings
   *  list: corrupt rows / missing FX rates contribute 0 and flag ok=false. */
  const rateToBase = (code: string): number =>
    live.fx ? fxService.toBase(1, code, live.fx) : code === base ? 1 : 0;

  const addAccount = () => {
    const name = platform.trim();
    if (!name) return;
    const d = parseFloat(deposit);
    const id = store.addAccount({
      platformName: name,
      accountType: acctType,
      initialDepositBase: Number.isFinite(d) && d > 0 ? d : undefined,
    });
    setAccountId(id);
    setPlatform('');
    setDeposit('');
    toast(`Account "${name}" created and set as target`);
  };

  /** Per-account live lines (account id -> AccountLine) so the account rows
   *  can show live value + P&L against the recorded deposit. */
  const accLines = useMemo(() => {
    const m = new Map<string, AccountLine>();
    if (live.portfolio) for (const a of live.portfolio.byAccount) m.set(a.account.id, a);
    return m;
  }, [live.portfolio]);

  // Contribution-aware portfolio P&L: live value vs total invested capital
  // (manual initial balances + every settled contribution). `null` when no
  // account has a recorded capital yet — the UI then prompts the user.
  const pnl = useMemo(() => {
    if (!live.portfolio) return null;
    return portfolioPnl(
      live.portfolio,
      vault.accounts,
      vault.contributions ?? [],
    );
  }, [live.portfolio, vault.accounts, vault.contributions]);

  /** Accounts already designated as emergency-reserve lines. */
  const reservedIds = useMemo(
    () => new Set((vault.emergency?.items ?? []).filter((i) => i.kind === 'account').map((i) => i.accountId)),
    [vault.emergency],
  );

  const toReserve = (id: string) => {
    const acc = vault.accounts.find((a) => a.id === id);
    if (!acc) return;
    store.addEmergencyItem({
      kind: 'account',
      name: acc.platformName,
      currency: base,
      accountId: id,
      createdAt: Date.now(),
    });
    toast(`"${acc.platformName}" added to the emergency reserve.`);
  };

  /** Reverse of toReserve. Tapping the reserved account row again removes its
   *  reserve line so the button never becomes a dead "In reserve" state that
   *  only EmergencyPanel can undo. */
  const unReserve = (id: string) => {
    const removed = (vault.emergency?.items ?? []).filter(
      (i) => i.kind === 'account' && i.accountId === id,
    );
    if (removed.length === 0) return;
    for (const item of removed) store.deleteEmergencyItem(item.id);
    toast(`Removed "${vault.accounts.find((a) => a.id === id)?.platformName ?? 'account'}" from the reserve.`);
  };

  const addHolding = async () => {
    // Par rows (cash/MMF): a single amount input, price pinned to 1, symbol
    // pinned to the class. value = amount · FX(1 holding cur -> base).
    const par = isParClass(assetClass);
    const am = parseFloat(amount);
    if (par && (!accountId || !isFinite(am) || am <= 0)) return;
    // Non-par rows: symbol + units + entry.
    const u = parseFloat(units);
    const e = parseFloat(entry);
    if (!par && (!accountId || !symbol.trim() || !isFinite(u) || u <= 0)) return;
    // For par rows, units ARE the amount and entry/price are pinned to 1.
    const finalUnits = par ? am : u;
    const finalEntry = par ? 1 : e;
    const finalSymbol = (par ? parSymbolFor(assetClass) : symbol.trim()).toUpperCase();
    // Pull an initial live quote so currentPriceBase is seeded (best-effort).
    let local = par ? 1 : e || 0;
    let priceBase = local;
    try {
      const rates = await fxService.latest(base);
      if (holdCur !== base) {
        const r = fxService.toBase(1, holdCur, rates);
        priceBase = Number.isFinite(r) ? local * r : 0;
      }
    } catch { /* offline: keep entry as a rough base price */ }
    const payload = {
      accountId,
      symbol: finalSymbol,
      assetClass,
      holdingCurrency: holdCur,
      units: finalUnits,
      averageEntryPrice: finalEntry,
      currentPriceLocal: local || undefined,
      currentPriceBase: priceBase || undefined,
    };
    store.addHolding(payload);
    setSymbol(''); setUnits(''); setEntry(''); setAmount('');
    toast(`Added ${finalSymbol} to target account`);
  };

  // ---- Edit-holding modal (pop-up) state + save -----------------------------
  const [mSymbol, setMSymbol] = useState('');
  const [mClass, setMClass] = useState<InvestmentHolding['assetClass']>('equity-us');
  const [mCur, setMCur] = useState(base);
  const [mUnits, setMUnits] = useState('');
  const [mEntry, setMEntry] = useState('');
  const [mAmount, setMAmount] = useState('');
  const mPar = isParClass(mClass);

  /** Prefill the modal from the holding being edited; close it (and reset
   *  the old inline edit state) on mount of the modal. */
  const openEdit = (h: InvestmentHolding) => {
    setMSymbol(h.symbol);
    setMClass(h.assetClass);
    setMCur(h.holdingCurrency);
    if (isParClass(h.assetClass)) {
      setMAmount(String(h.units || ''));
      setMUnits(''); setMEntry('');
      setMSymbol(parSymbolFor(h.assetClass));
    } else {
      setMUnits(String(h.units));
      setMEntry(String(h.averageEntryPrice || ''));
      setMAmount('');
    }
    setEditHolding(h);
  };

  const closeEdit = () => {
    setEditHolding(null);
  };

  // ---- Set starting capital modal ------------------------------------------
  const [depOpen, setDepOpen] = useState(false);
  const [depFocusId, setDepFocusId] = useState<string | null>(null);
  const openDeposit = (focusAccountId?: string) => {
    setDepFocusId(focusAccountId ?? null);
    setDepOpen(true);
  };

  // ---- Set cost basis fast path ---------------------------------------------
  // Enter total invested per account (from StashAway's "Total invested"), and
  // it back-fills each holding's entry price proportionally by current value,
  // so cost-basis P&L matches the broker without editing every row.
  const [costOpen, setCostOpen] = useState(false);
  // Per-account "total invested" draft, keyed by account id (base currency).
  const [costDrafts, setCostDrafts] = useState<Record<string, string>>({});
  const openCostBasis = () => {
    // Seed each account's "total invested" with the best known figure, in
    // priority order: recorded starting capital -> settled contributions ->
    // existing cost basis -> live value (last resort, labelled). Never seed
    // live value as if it were the investment amount, or saving would make
    // P&L read 0.00%.
    const seeds: Record<string, string> = {};
    for (const a of vault.accounts) {
      const contribs = (vault.contributions ?? []).reduce((s, c) => c.accountId === a.id ? s + (Number.isFinite(c.amountBase) ? c.amountBase : 0) : s, 0);
      const preferred =
        (Number.isFinite(a.initialDepositBase) && (a.initialDepositBase ?? 0) > 0 ? a.initialDepositBase! : null)
        ?? (contribs > 0 ? contribs : null)
        ?? null;
      const line = live.portfolio?.byAccount.find((l) => l.account.id === a.id);
      seeds[a.id] = preferred != null
        ? String(Math.round(preferred * 100) / 100)
        : (line && line.costBase > 0 ? String(Math.round(line.costBase * 100) / 100) : '');
    }
    setCostDrafts(seeds);
    setCostOpen(true);
  };

  /** Save the fast path: set initialDepositBase + distribute total invested
   *  across each account's holdings as entry prices (proportional to their
   *  current value, so the sum of holding costs ≈ the total invested). */
  const saveCostBasis = async () => {
    let touched = 0;
    for (const a of vault.accounts) {
      const raw = (costDrafts[a.id] ?? '').trim();
      const totalInvested = parseFloat(raw);
      if (raw === '') continue;
      if (!Number.isFinite(totalInvested) || totalInvested <= 0) continue;
      // 1) Drive the capital-based P&L from the broker's "total invested".
      store.updateAccount(a.id, { initialDepositBase: totalInvested });
      // 2) Distribute the total invested across non-par holdings in
      //    proportion to their value, so the sum of holding costs ≈ the
      //    total invested. Par (cash/MMF) rows keep entry = 1.
      const lines = live.portfolio?.byAccount.find((l) => l.account.id === a.id)?.lines ?? [];
      const distributable = lines.filter(
        (l) => !isParClass(l.holding.assetClass) && l.valueBase > 0 && Number.isFinite(l.holding.units) && l.holding.units > 0,
      );
      const totalDistValue = distributable.reduce((s, l) => s + l.valueBase, 0);
      if (totalDistValue > 0) {
        for (const l of distributable) {
          // This holding's share of the total invested, in its currency.
          const shareBase = (l.valueBase / totalDistValue) * totalInvested;
          const h = l.holding;
          const toCur = h.holdingCurrency === base ? 1 : (live.fx ? fxService.toBase(1, h.holdingCurrency, live.fx) : NaN);
          const shareLocal = Number.isFinite(toCur) && toCur > 0 ? shareBase / toCur : 0;
          const entryPerUnit = h.units > 0 ? shareLocal / h.units : 0;
          if (Number.isFinite(entryPerUnit) && entryPerUnit > 0) {
            store.updateHolding(h.id, { averageEntryPrice: Math.round(entryPerUnit * 100) / 100 });
            touched++;
          }
        }
      }
    }
    setCostOpen(false);
    toast(touched > 0 ? `Cost basis set · ${touched} holding${touched === 1 ? '' : 's'} updated` : 'Cost basis saved');
  };
  // When opened focused on a specific account, scroll it into view + focus it.
  useEffect(() => {
    if (!depOpen || !depFocusId) return;
    const el = document.querySelector(`[data-dep-focus="1"] .dep-input`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (el as HTMLElement).focus();
    }
  }, [depOpen, depFocusId]);

  /** Persist the modal edits back to the holding via updateHolding. */
  const saveHoldingEdit = async () => {
    const h = editHolding;
    if (!h) return;
    const par = isParClass(mClass);
    const am = parseFloat(mAmount);
    const u = parseFloat(mUnits);
    const e = parseFloat(mEntry);
    if (par && (!isFinite(am) || am <= 0)) {
      toast('Amount must be a positive number.', 'err');
      return;
    }
    if (!par && (!mSymbol.trim() || !isFinite(u) || u <= 0)) {
      toast('Symbol and positive units are required.', 'err');
      return;
    }
    const finalUnits = par ? am : u;
    const finalEntry = par ? 1 : e;
    const finalSymbol = (par ? parSymbolFor(mClass) : mSymbol.trim()).toUpperCase();
    // Seed a live quote best-effort (same as addHolding).
    let local = par ? 1 : e || 0;
    let priceBase = local;
    try {
      const rates = await fxService.latest(base);
      if (mCur !== base) {
        const r = fxService.toBase(1, mCur, rates);
        priceBase = Number.isFinite(r) ? local * r : 0;
      }
    } catch { /* offline */ }
    store.updateHolding(h.id, {
      accountId: h.accountId,
      symbol: finalSymbol,
      assetClass: mClass,
      holdingCurrency: mCur,
      units: finalUnits,
      averageEntryPrice: finalEntry,
      currentPriceLocal: local || undefined,
      currentPriceBase: priceBase || undefined,
    });
    closeEdit();
    toast(`Updated ${finalSymbol}`);
  };

  const removeAccount = (id: string) => {
    const acc = vault.accounts.find((a) => a.id === id);
    const count = vault.holdings.filter((h) => h.accountId === id).length;
    store.deleteAccount(id);
    if (accountId === id) setAccountId('');
    toast(`Deleted "${acc?.platformName ?? 'account'}"` + (count > 0 ? ` and ${count} holding${count === 1 ? '' : 's'}` : ''));
  };

  return (
    <>
      <h2 className="section-title">Portfolio</h2>
      <div className="card">
        {/* Hero band: big number + tinted delta + a 3-cell stats strip. */}
        <div className="pf-hero">
          <div className="pf-hero-main">
            <div className="pf-hero-lbl">Total value · {base}</div>
            <div className="pf-hero-num">{formatMoney(live.portfolio?.totalValueBase ?? 0, base)}</div>
            <div className="pf-hero-delta">
              {/* Primary KPI: P&L against "Total invested" (initialDepositBase).
                  This is the broker's own cost basis (StashAway "Net deposits",
                  HATA "Total invested"). A per-holding averageEntryPrice for a
                  robo-advisor fund is the fund's NAV at purchase — not the
                  user's actual cash cost — so it understates the true loss.
                  Fall back to cost-basis P&L only when no account has a
                  recorded initial balance yet. */}
              {pnl && pnl.totalPnlBase != null ? (
                <span className={`pf-delta ${pnl.totalPnlBase >= 0 ? 'up' : 'down'}`}>
                  {pnl.totalPnlBase >= 0 ? '▲' : '▼'}{' '}
                  {Math.abs(pnl.totalPnlBase) > 0
                    ? `${pnl.totalPnlBase >= 0 ? '+' : '−'}${formatMoney(Math.abs(pnl.totalPnlBase), base)}`
                    : 'Breakeven'}
                  {pnl.totalReturnPct != null ? (
                    <span className="pf-delta-pct">
                      {pnl.totalReturnPct >= 0 ? '+' : '−'}{Math.abs(pnl.totalReturnPct).toFixed(1)}%
                    </span>
                  ) : null}
                </span>
              ) : pnl && pnl.totalCostPnlBase != null ? (
                <span className={`pf-delta ${pnl.totalCostPnlBase >= 0 ? 'up' : 'down'}`}>
                  {pnl.totalCostPnlBase >= 0 ? '▲' : '▼'}{' '}
                  {Math.abs(pnl.totalCostPnlBase) > 0
                    ? `${pnl.totalCostPnlBase >= 0 ? '+' : '−'}${formatMoney(Math.abs(pnl.totalCostPnlBase), base)}`
                    : 'Breakeven'}
                  {pnl.totalCostReturnPct != null ? (
                    <span className="pf-delta-pct">
                      {pnl.totalCostReturnPct >= 0 ? '+' : '−'}{Math.abs(pnl.totalCostReturnPct).toFixed(1)}%
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="muted small">No cost basis recorded yet</span>
              )}
            </div>
          </div>
          <div className="pf-hero-stats">
            <div className="pf-stat">
              <div className="pf-stat-num">{vault.holdings.length}</div>
              <div className="pf-stat-lbl">Holdings</div>
            </div>
            <div className="pf-stat">
              <div className="pf-stat-num">{live.portfolio?.liveQuoteCount ?? 0}</div>
              <div className="pf-stat-lbl">Live quotes</div>
            </div>
            <div className="pf-stat">
              <div className="pf-stat-num">{vault.accounts.length}</div>
              <div className="pf-stat-lbl">Accounts</div>
            </div>
          </div>
        </div>

        {/* P&L is undefined until at least one account has a recorded
            invested capital. Surface that as an actionable prompt so the
            user knows exactly what to do, and show it whenever some but not
            all accounts are covered. */}
        {pnl && pnl.totalCapitalBase === 0 && vault.accounts.length > 0 && (
          <div className="row small" style={{ marginBottom: 8, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="chip sm">No capital recorded yet</span>
            <span className="muted grow">Set a starting balance per account, or log a contribution — P&L then measures against what you've actually invested.</span>
            <button className="btn sm" onClick={() => openDeposit()}>Set starting capital</button>
          </div>
        )}
        {pnl && pnl.missingCapitalCount > 0 && pnl.totalCapitalBase > 0 && (
          <div className="row small muted" style={{ marginBottom: 8 }}>
            P&L covers {pnl.accounts.length - pnl.missingCapitalCount} of {pnl.accounts.length} accounts · {pnl.missingCapitalCount} without a recorded balance
          </div>
        )}

        {/* Per-account P&L breakdown — shows each account's gain/loss
            side by side so the user can see "StashAway −RM X · HATA ±RM Y"
            instead of a blended aggregate that masks which leg is down.
            Primary metric: pnlBase (value − initialDepositBase = broker's
            "Total invested / Net deposits"). This is the correct cost basis
            for a robo-advisor account like StashAway where per-holding
            averageEntryPrice is the fund NAV, not your actual cash cost.
            Falls back to costPnlBase (value − sum of entry prices) when no
            initial balance has been recorded for that account. */}
        {pnl && pnl.accounts.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Per-account P&L</div>
            {pnl.accounts.map((l) => {
              // Prefer pnlBase (against "Total invested") when the user has
              // recorded an initial balance; fall back to costPnlBase.
              const pnlVal = l.pnlBase != null ? l.pnlBase : l.costPnlBase;
              const retPct = l.pnlBase != null ? l.returnPct : l.costReturnPct;
              const neg = (pnlVal ?? 0) < 0;
              return (
                <div key={l.account.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: 14 }}>{l.account.platformName}</div>
                  <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div className="row" style={{ gap: 8, justifyContent: 'flex-end', alignItems: 'baseline' }}>
                      <span style={{ color: neg ? 'var(--bad)' : 'var(--good)', fontWeight: 700, fontSize: 14 }}>
                        {pnlVal != null ? `${neg ? '−' : '+'}${formatMoney(Math.abs(pnlVal!), base)}` : 'n/a'}
                      </span>
                      {retPct != null && (
                        <span className="small" style={{ color: neg ? 'var(--bad)' : 'var(--good)' }}>
                          ({retPct >= 0 ? '+' : '−'}{Math.abs(retPct).toFixed(1)}%)
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Allocation by asset class — the single hero chart of the page:
            a smooth segmented bar with an interactive per-class breakdown.
            (Replaces the old stacked bar + separate donut pair.) */}
        {pieSlices.length > 0 ? (
          <div className="pf-breakdown" style={{ marginTop: 18 }}>
            <div className="pf-breakdown-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, letterSpacing: '-0.2px' }}>Your mix</div>
                <div className="small muted" style={{ margin: '2px 0 0' }}>
                  Tap a slice to pin it — the donut and bar highlight it
                </div>
              </div>
              <div className="seg" role="tablist" aria-label="Allocation view">
                <button
                  type="button"
                  aria-pressed={activePie === 'class'}
                  onClick={() => setActivePie('class')}
                >
                  By class
                </button>
                <button
                  type="button"
                  aria-pressed={activePie === 'holding'}
                  onClick={() => setActivePie('holding')}
                >
                  By holding
                </button>
              </div>
            </div>
            <AllocationPie
              slices={pieSlices}
              total={totalPieValue}
              base={base}
              title={activePie === 'class' ? 'portfolio' : 'holdings'}
            />
          </div>
        ) : null}

        {/* ================= PERFORMANCE =================
            The "am I gaining or losing money?" section. Three parts:
              1) A big GAIN / LOSS headline — primary metric is P&L vs.
                 "Total invested" (initialDepositBase = broker's Net deposits).
                 Falls back to cost-basis P&L when no account has a recorded
                 initial balance yet.
              2) A per-account P&L breakdown (value, cost, P&L, return %).
              3) A cost-basis audit: any holding with a missing entry price
                 is what makes the number read green when it should be red.
        */}
        {(() => {
          // Primary: P&L vs "Total invested" (the broker's own cost basis).
          // Fallback: cost-basis P&L when no account has a recorded initial
          // balance yet (no initialDepositBase, no contributions).
          const primaryPnl = pnl?.totalPnlBase != null ? pnl.totalPnlBase : pnl?.totalCostPnlBase ?? null;
          const primaryRet = pnl?.totalPnlBase != null ? pnl.totalReturnPct : pnl?.totalCostReturnPct ?? null;
          const totalValue = live.portfolio?.totalValueBase ?? 0;
          const totalCost = live.portfolio?.totalCostBase ?? 0;

          // Cost-basis audit: non-par holdings with no recorded entry price.
          const auditGaps = vault.holdings
            .filter((h) => h.assetClass !== 'cash' && h.assetClass !== 'mmf')
            .filter((h) => !(Number.isFinite(h.averageEntryPrice) && h.averageEntryPrice > 0))
            .map((h) => ({ symbol: h.symbol, units: h.units }));

          const isLoss = primaryPnl != null && primaryPnl < 0;
          const isGain = primaryPnl != null && primaryPnl > 0;

          return (
            <div style={{ marginTop: 18 }}>
              <h2 className="section-title">Performance</h2>

              {/* Headline card: the single most important number. */}
              <div className="card" style={{ marginBottom: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div className="small muted">{pnl?.totalPnlBase != null ? 'GAIN / LOSS vs. total invested' : 'GAIN / LOSS vs. total cost'}</div>
                    {primaryPnl != null ? (
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800, letterSpacing: '-0.5px', marginTop: 4, color: isLoss ? 'var(--bad)' : isGain ? 'var(--good)' : 'var(--text)' }}>
                        {isLoss ? '▼ Losing' : isGain ? '▲ Gaining' : '— Breakeven'}
                        <span style={{ fontSize: 18, marginLeft: 8, fontWeight: 700 }}>
                          {isLoss ? '−' : isGain ? '+' : ''}{formatMoney(Math.abs(primaryPnl), base)}
                        </span>
                        {primaryRet != null && (
                          <span className="muted" style={{ fontSize: 14, marginLeft: 6, fontWeight: 600 }}>
                            ({primaryRet >= 0 ? '+' : '−'}{Math.abs(primaryRet).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 16, marginTop: 4 }}>No cost basis recorded yet</div>
                    )}
                    <div className="small muted" style={{ marginTop: 6 }}>
                      Value {formatMoney(totalValue, base)} · Cost {formatMoney(totalCost, base)}
                    </div>
                  </div>
                </div>

                {/* Actionable fix when the audit finds gaps (the usual reason
                    for a false "green" or 0.00% reading). */}
                {auditGaps.length > 0 && (
                  <div className="row small" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: 10, borderRadius: 10, background: 'var(--bad-soft, rgba(239,68,68,0.12))', border: '1px solid color-mix(in srgb, var(--bad) 30%, transparent)' }}>
                    <span style={{ fontWeight: 600, color: 'var(--bad)' }}>⚠ {auditGaps.length} holding{auditGaps.length === 1 ? '' : 's'} missing entry price</span>
                    <span className="muted grow">
                      {auditGaps.slice(0, 4).map((g) => g.symbol).join(', ')}{auditGaps.length > 4 ? ` +${auditGaps.length - 4} more` : ''}
                    </span>
                    <button className="btn sm" onClick={() => openCostBasis()}>Set cost basis from broker</button>
                  </div>
                )}
                {/* Fast-path button always available so you can (re)sync your
                    real StashAway/Broker "total invested" at any time. */}
                {vault.accounts.length > 0 && (
                  <div className="row small" style={{ marginTop: 10, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn ghost sm" onClick={() => openCostBasis()}>
                      Use my broker's "total invested" (StashAway) instead of per-holding entry prices
                    </button>
                  </div>
                )}
              </div>

            </div>
          );
        })()}

        {(() => {
          const withDep = live.portfolio?.byAccount.filter((a) => a.depositBase != null && a.valueBase > 0) ?? [];
          if (withDep.length === 0) return null;
          const dep = withDep.reduce((s, a) => s + (a.depositBase ?? 0), 0);
          const pnl = withDep.reduce((s, a) => s + (a.valueBase - (a.depositBase ?? 0)), 0);
          const pct = dep > 0 ? (pnl / dep) * 100 : 0;
          return (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="small muted">
                {'P&L on recorded capital: '}<span className={pnl >= 0 ? 'pos' : 'neg'}>{pnl >= 0 ? '+' : ''}{formatMoney(pnl, base)} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
                {withDep.length < (live.portfolio?.byAccount.length ?? 0) && (
                  <span> · {withDep.length} of {live.portfolio?.byAccount.length} accounts</span>
                )}
              </span>
            </div>
          );
        })()}
        {live.error && <div className="small neg" style={{ marginTop: 10 }}>{live.error}</div>}
        <div className="row small muted" style={{ marginTop: 10 }}>
          <span>
            FX: {live.fxSource === 'offline' ? 'offline (cached/approx)' : (live.fxSource ?? '…')} · live {live.portfolio?.liveQuoteCount ?? 0} · cached {live.portfolio?.staleQuoteCount ?? 0}
          </span>
          {live.portfolio && live.portfolio.uncounted > 0 && (
            <span style={{ color: 'var(--text-2, #9aa4b8)' }}> · {live.portfolio.uncounted} uncounted</span>
          )}
          <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}><IRefresh size={16} /> Refresh</button>
        </div>
      </div>

      {/* ---- Portfolio strategy + target allocation -------------------------
          The user picks a famous strategy (or "my own targets") and that
          target drives both the rebalance engine and the coach's new-money
          advice. Persisted in prefs.coachStrategy / prefs.targetAllocation. */}
      <h2 className="section-title">Strategy & targets</h2>
      <div className="card">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="chip sm">Strategy</span>
          <ThemedSelect
            value={vault.prefs.coachStrategy ?? '60-40'}
            onChange={(v: string) => store.setPrefs({ coachStrategy: v })}
            options={(Object.values(FAMED_STRATEGIES)).map((s) => ({ value: s.key, label: s.name }))}
            aria-label="Portfolio strategy"
          />
        </div>
        {(() => {
          const key = vault.prefs.coachStrategy ?? '60-40';
          const strat = FAMED_STRATEGIES[key as keyof typeof FAMED_STRATEGIES];
          if (!strat) return null;
          if (key === 'custom') {
            return (
              <div style={{ marginTop: 10 }}>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  Set your target weights per asset class (sums to 100%).
                  These drive the rebalance engine and the coach's new-money advice.
                </div>
                {(() => {
                  const custom = vault.prefs.targetAllocation ?? {};
                  // All known asset classes — show every row so the user can
                  // add/remove by setting 0 or a value.
                  const allClasses = [...ASSET_CLASSES] as readonly string[];
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                      {allClasses.map((cls) => {
                        const cur = custom[cls] != null ? Math.round((custom[cls] as number) * 100) : 0;
                        return (
                          <label key={cls} className="field" style={{ marginBottom: 0 }}>
                            <span style={{ textTransform: 'capitalize' }}>{cls}</span>
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              max={100}
                              value={cur === 0 ? '' : cur}
                              placeholder="0"
                              onChange={(e) => {
                                const raw = e.target.value;
                                const v = raw === '' ? undefined : Number(raw) / 100;
                                const next = { ...custom };
                                if (v === undefined || Number.isNaN(v)) delete next[cls];
                                else next[cls] = Math.max(0, Math.min(1, v));
                                store.setPrefs({ targetAllocation: next });
                              }}
                              style={{ width: '100%' }}
                            />
                          </label>
                        );
                      })}
                    </div>
                  );
                })()}
                {(() => {
                  const custom = vault.prefs.targetAllocation ?? {};
                  const total = Object.values(custom).reduce((s, w) => s + (Number.isFinite(w) ? w : 0), 0);
                  const totalPct = Math.round(total * 100);
                  return (
                    <div style={{ marginTop: 8 }} className={`small ${totalPct === 100 ? 'pos' : totalPct === 0 ? 'muted' : 'neg'}`}>
                      {totalPct === 0
                        ? 'No targets set — set at least one class above.'
                        : totalPct === 100
                          ? 'Targets sum to 100% — saved.'
                          : `Targets currently sum to ${totalPct}% — the rebalance engine normalises automatically, but 100% is cleanest.`}
                    </div>
                  );
                })()}
              </div>
            );
          }
          return (
            <div style={{ marginTop: 10 }}>
              <div className="small muted">{strat.blurb}</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {Object.entries(strat.allocation).map(([cls, w]) => (
                  <span key={cls} className="chip sm ok">{cls} {Math.round(w * 100)}%</span>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      <Disclosure id="accounts" title={`Accounts${vault.accounts.length ? ` (${vault.accounts.length})` : ''}`}>
      <div className="card">
        <div className="cols">
          <label className="field"><span>Platform (Luno, IBKR, Moomoo…)</span>
            <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="StashAway" />
          </label>
          <label className="field"><span>Type</span>
            <ThemedSelect
              value={acctType}
              onChange={(v: string) => setAcctType(v as typeof acctType)}
              options={[
                { value: 'broker', label: 'Broker' },
                { value: 'robo', label: 'Robo-advisor' },
                { value: 'crypto', label: 'Crypto wallet' },
                { value: 'cash', label: 'Cash / MMF' },
                { value: 'other', label: 'Other' },
              ]}
              aria-label="Account type"
            />
          </label>
          <label className="field"><span>Starting capital ({base}, optional)</span>
            <input type="number" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="5000" />
          </label>
        </div>
        <button className="btn ghost sm" onClick={addAccount} style={{ width: '100%' }}><IPlus size={16} /> Create account</button>

        {vault.accounts.length > 0 && (
          <div className="list">
            {vault.accounts.map((a) => {
              const holdings = vault.holdings.filter((h) => h.accountId === a.id).length;
              const isTarget = a.id === accountId;
              const line = accLines.get(a.id);
              const hasDeposit = typeof a.initialDepositBase === 'number' && a.initialDepositBase > 0;
              const reserved = reservedIds.has(a.id);
              const pnlGood = line?.pnlBase != null && line.pnlBase >= 0;
              const pnlBad = line?.pnlBase != null && line.pnlBase < 0;
              return (
                <div className="acc-card" key={a.id}>
                  <div className="acc-head">
                    <div className="acc-name grow">
                      {a.platformName}
                      {isTarget && (
                        <button className={`chip sm ${isTarget ? 'on' : ''}`} aria-pressed={isTarget} onClick={() => setAccountId(a.id)} title="Holding form target">
                          <ICheck size={12} /> target
                        </button>
                      )}
                      {reserved && (
                        <button className="chip sm ok" aria-pressed title="Remove from emergency reserve" onClick={() => unReserve(a.id)}>
                          in reserve
                        </button>
                      )}
                    </div>
                    <MenuButton
                      items={[
                        {
                          label: reserved ? 'Remove from reserve' : 'Add to reserve',
                          icon: ICheck,
                          onClick: () => (reserved ? unReserve(a.id) : toReserve(a.id)),
                        },
                        {
                          label: 'Set as target',
                          icon: ICheck,
                          hide: isTarget,
                          onClick: () => setAccountId(a.id),
                        },
                      {
                          label: 'Edit starting capital',
                          icon: IPlus,
                          onClick: () => openDeposit(a.id),
                        },
                        { label: 'Delete account', danger: true, onClick: () => removeAccount(a.id) },
                      ]}
                    />
                  </div>
                  <div className="acc-value">
                    {line && line.valueBase > 0 ? (
                      <span className="val">{formatMoney(line.valueBase, base)}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {line?.depositBase != null && (
                      <span className={`ret ${pnlGood ? 'pos' : pnlBad ? 'neg' : ''}`}>
                        {line.pnlBase! >= 0 ? '+' : ''}{formatMoney(line.pnlBase!, base)} ({line.depositReturnPct! >= 0 ? '+' : ''}{line.depositReturnPct!.toFixed(1)}%)
                      </span>
                    )}
                  </div>
                  {/* Per-account share of the total portfolio value. */}
                  {line && live.portfolio && live.portfolio.totalValueBase > 0 ? (
                    <div style={{ marginTop: 8 }}>
                      <div className="bar" style={{ height: 5 }}>
                        <i style={{
                          width: `${Math.min(100, (line.valueBase / live.portfolio.totalValueBase) * 100)}%`,
                        }} />
                      </div>
                      <div className="muted small" style={{ marginTop: 2 }}>
                        {((line.valueBase / live.portfolio.totalValueBase) * 100).toFixed(1)}% of portfolio
                      </div>
                    </div>
                  ) : null}
                  <div className="acc-foot">
                    <span className="muted small">{a.accountType} · {holdings} holding{holdings === 1 ? '' : 's'}</span>
                    <button
                      className={`dep-edit${hasDeposit ? '' : ' empty'}`}
                      onClick={() => openDeposit(a.id)}
                      title="Edit starting capital"
                    >
                      {hasDeposit ? (
                        <>
                          <span className="val">{formatMoney(a.initialDepositBase!, base)}</span>
                          <IPencil size={13} />
                        </>
                      ) : (
                        <>
                          Set starting capital
                          <IPlus size={13} />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {vault.accounts.length === 0 && (
          <div className="empty">No accounts yet — create one above.</div>
        )}
      </div>
      </Disclosure>

      <h2 className="section-title">Emergency reserve</h2>
      <EmergencyPanel />

      <h2 className="section-title">Savings goals</h2>
      <SavingsGoalsPanel />

      {/* Contributions come first: this is how the client records money
          actually invested (with a date) so P&L stays honest. Standing
          auto-invest plans follow (the client's own scheduler, optional). */}
      <h2 className="section-title">Contributions</h2>
      <ContributionPanel fx={live.fx} />

      {vault.autoInvests && vault.autoInvests.length > 0 && (
        <>
          <h2 className="section-title">Auto-invest plans</h2>
          <AutoInvestPanel fx={live.fx} />
        </>
      )}

      <Disclosure id="add-holding" title="Add holding" defaultOpen={accountId !== ''}>
      <div className="card">
        {!accountId && (
          <div className="small muted" style={{ marginBottom: 8 }}>
            Set a target account above, then add holdings to it.
          </div>
        )}
        <div className="cols">
          <label className="field"><span>Symbol</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              disabled={parMode}
              placeholder={parMode ? 'auto (par)' : 'AAPL / CSPX.L / BTC / 1155.KL'}
            />
          </label>
          <label className="field"><span>Asset class</span>
            <ThemedSelect
              value={assetClass}
              onChange={(v: string) => pickAssetClass(v as typeof assetClass)}
              options={ASSET_CLASSES.map((c) => ({ value: c, label: c }))}
              aria-label="Asset class"
            />
          </label>
          {parMode ? (
            <label className="field"><span>Amount ({holdCur})</span>
              <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1500" />
            </label>
          ) : (
            <>
              <label className="field"><span>Units</span>
                <input type="number" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="10" />
              </label>
              <label className="field"><span>Avg entry</span>
                <input type="number" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="12.40" />
              </label>
            </>
          )}
          <label className="field"><span>Holding cur</span>
            <ThemedSelect
              value={holdCur}
              onChange={(v: string) => setHoldCur(v)}
              options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))}
              aria-label="Holding currency"
            />
          </label>
        </div>
        <button className={`btn sm${accountId ? '' : ' ghost'}`} style={{ width: '100%' }} disabled={!accountId} onClick={() => void addHolding()}>
          {accountId ? 'Add holding' : 'Set a target account first'}
        </button>
      </div>
      </Disclosure>

      {/* Edit holding — pop-up (bottom sheet on phones, centered card on desktop). */}
      {editHolding && (
        <Modal title={`Edit ${editHolding.symbol} holding`} onClose={closeEdit}>
          <div className="cols">
            <label className="field"><span>Symbol</span>
              <input
                value={mSymbol}
                onChange={(e) => setMSymbol(e.target.value)}
                disabled={mPar}
                placeholder={mPar ? 'auto (par)' : 'AAPL / CSPX.L / BTC / 1155.KL'}
              />
            </label>
            <label className="field"><span>Asset class</span>
              <ThemedSelect
                value={mClass}
                onChange={(v: string) => {
                  const c = v as InvestmentHolding['assetClass'];
                  setMClass(c);
                  if (isParClass(c)) setMSymbol(parSymbolFor(c));
                }}
                options={ASSET_CLASSES.map((c) => ({ value: c, label: c }))}
                aria-label="Asset class"
              />
            </label>
            {mPar ? (
              <label className="field"><span>Amount ({mCur})</span>
                <input type="number" inputMode="decimal" value={mAmount} onChange={(e) => setMAmount(e.target.value)} placeholder="1500" />
              </label>
            ) : (
              <>
                <label className="field"><span>Units</span>
                  <input type="number" inputMode="decimal" value={mUnits} onChange={(e) => setMUnits(e.target.value)} placeholder="10" />
                </label>
                <label className="field"><span>Avg entry</span>
                  <input type="number" inputMode="decimal" value={mEntry} onChange={(e) => setMEntry(e.target.value)} placeholder="12.40" />
                </label>
              </>
            )}
            <label className="field"><span>Holding cur</span>
              <ThemedSelect
                value={mCur}
                onChange={(v: string) => setMCur(v)}
                options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))}
                aria-label="Holding currency"
              />
            </label>
          </div>
          <div className="row" style={{ marginTop: 14, gap: 10 }}>
            <button className="btn ghost sm" style={{ flex: 1 }} onClick={closeEdit}>Cancel</button>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => void saveHoldingEdit()}>Save changes</button>
          </div>
        </Modal>
      )}

      {/* Set starting capital — one input per account, drives the P&L KPI. */}
      {depOpen && (
        <Modal title="Set starting capital" onClose={() => setDepOpen(false)}>
          <p className="small muted" style={{ marginTop: 0 }}>
            The amount you initially invested in each account. P&amp;L on capital compares your live
            value against this. Leave a field blank to clear it.
          </p>
          {vault.accounts.length === 0 && (
            <div className="row small muted" style={{ marginBottom: 8 }}>
              Create an account above first — starting capital is set per account.
            </div>
          )}
          <div className="list" style={{ marginTop: 8 }}>
            {vault.accounts.map((a) => (
              <div className="item" key={a.id} data-dep-focus={a.id === depFocusId ? '1' : undefined}>
                <div className="grow">
                  <div className="title">{a.platformName}</div>
                  <div className="meta muted small">{a.accountType} · {formatMoney(a.baseCurrencyValue || 0, base)}</div>
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  className={`dep-input${a.id === depFocusId ? ' focus' : ''}`}
                  value={typeof a.initialDepositBase === 'number' ? String(a.initialDepositBase) : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    store.updateAccount(a.id, {
                      initialDepositBase: v.trim() === '' ? undefined : parseFloat(v),
                    });
                  }}
                  placeholder={base}
                  aria-label={`Starting capital for ${a.platformName}`}
                />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => setDepOpen(false)}>Done</button>
          </div>
        </Modal>
      )}

      {/* Set cost basis fast path — enter your broker's "total invested" per
          account; it back-fills each holding's entry price proportionally so
          cost-basis P&L matches StashAway without editing every row. */}
      {costOpen && (
        <Modal title="Set cost basis from broker" onClose={() => setCostOpen(false)}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Enter your broker's <b>total invested</b> for each account — StashAway's{" "}
            <b>Net deposits</b> (NOT the current value). It updates the P&amp;L immediately and
            back-fills your holdings' entry prices in proportion to their value —
            no need to edit each row. Leave a field blank to skip that account.
          </p>
          {vault.accounts.length === 0 && (
            <div className="row small muted" style={{ marginBottom: 8 }}>
              Create an account first — cost basis is set per account.
            </div>
          )}
          <div className="list" style={{ marginTop: 8 }}>
            {vault.accounts.map((a) => {
              const line = live.portfolio?.byAccount.find((l) => l.account.id === a.id);
              const liveValue = line?.valueBase ?? 0;
              // P&L preview uses the live quote-derived value (which now
              // references the same index StashAway prices off — see
              // STASHAWAY_INDEX_MAP — so it tracks StashAway's daily NAV).
              const entered = parseFloat((costDrafts[a.id] ?? '').trim());
              const previewPnl = Number.isFinite(entered) && entered > 0 ? liveValue - entered : null;
              const previewPct = previewPnl != null ? (previewPnl / entered) * 100 : null;
              return (
                <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 13 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="title" style={{ fontWeight: 600, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.platformName}</div>
                      <div className="small muted" style={{ marginTop: 2 }}>{a.accountType} · live value {formatMoney(liveValue, base)}</div>
                    </div>
                  </div>
                  <label className="field" style={{ width: '100%', marginBottom: 0 }}>
                    <span>Total invested ({base})</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={costDrafts[a.id] ?? ''}
                      onChange={(e) => setCostDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                      placeholder="e.g. 30000"
                      aria-label={`Total invested for ${a.platformName}`}
                      style={{ width: '100%' }}
                    />
                  </label>
                  {previewPnl != null && (
                    <div className="small" style={{ color: previewPnl < 0 ? 'var(--bad)' : previewPnl > 0 ? 'var(--good)' : 'var(--text-2, #9aa4b8)' }}>
                      → P&amp;L will read {previewPnl >= 0 ? '+' : '−'}{formatMoney(Math.abs(previewPnl), base)}
                      {previewPct != null ? ` (${previewPct >= 0 ? '+' : '−'}${Math.abs(previewPct).toFixed(1)}%)` : ''}
                      <span className="muted"> · live value {formatMoney(liveValue, base)}</span>
                    </div>
                  )}
                  {/* Guard: entering (nearly) the live value makes P&L read
                      ~0% — the exact mistake that masks a real loss. StashAway
                      users should use their "Net deposits" figure instead. */}
                  {Number.isFinite(entered) && entered > 0 && liveValue > 0 && Math.abs(entered - liveValue) / liveValue < 0.005 && (
                    <div className="small" style={{ color: 'var(--warn, #d97706)', fontWeight: 600 }}>
                      ⚠ This equals the live value — P&L would read 0%. Use your broker's
                      {' '}<b>Net deposits / total invested</b> instead.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 14, gap: 8 }}>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => void saveCostBasis()}>Save cost basis</button>
            <button className="btn ghost sm" onClick={() => setCostOpen(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {[...grouped.entries()].map(([plat, holds]) => (
        <div key={plat}>
          <h2 className="section-title">{plat}</h2>
          <div className="list">
            {holds.map((h) => {
              const q = live.quotes[h.symbol];
              const { valueBase: val, costBase: cost, ok } = valueInBase(
                h,
                q,
                base,
                rateToBase,
              );
              const isLive = q?.source === 'coingecko' || q?.source === 'yahoo';
              const ret = ok && cost > 0 ? ((val - cost) / cost) * 100 : 0;
              const par = isParClass(h.assetClass);
              const price = q?.price ?? h.currentPriceBase;
              const showPrice = par
                ? 'par'
                : Number.isFinite(price) ? sym + price!.toFixed(3) : '—';
              const showVal = ok ? sym + val.toFixed(0) : '—';
              const showRet = ok && cost > 0 ? ` ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%` : '';
              const note = !ok ? ' · uncounted (corrupt/no FX rate)' : '';
              return (
                <div className="item" key={h.id}>
                  <div className="grow">
                    <div className="title">{h.symbol} <span className="muted small">× {Number.isFinite(h.units) ? h.units : '—'} {h.holdingCurrency}</span></div>
                    <div className="meta">
                      {h.assetClass} · {q ? (isLive ? `live ${new Date(q.asOf).toLocaleString()}` : `cached ${new Date(q.asOf).toLocaleDateString()}`) : 'no quote'}
                      {' '}· {showPrice}{note}
                    </div>
                  </div>
                  <div className="amt">
                    {showVal}
                    <span className={ret >= 0 ? 'pos small' : 'neg small'}>{showRet}</span>
                  </div>
                  <button
                    className="edit"
                    title={`Edit ${h.symbol} holding`}
                    aria-label={`Edit ${h.symbol} holding`}
                    onClick={() => startEdit(h)}
                  >
                    <IPencil size={16} />
                  </button>
                  <DelButton
                    label={`Delete ${h.symbol} holding`}
                    onConfirm={() => {
                      store.deleteHolding(h.id);
                      if (editHolding?.id === h.id) closeEdit();
                      toast(`Deleted ${h.symbol} holding`);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {vault.holdings.length === 0 && (
        <div className="empty">
          No holdings yet. Create an account, then add a holding above — or log a
          contribution below to start tracking invested capital.
        </div>
      )}
    </>
  );
}

/** Themed overflow menu for an account card. A single 44px "⋯" button
 *  replaces three side-by-side ghost buttons that no longer fit on phones,
 *  keeping destructive delete inside a two-tap armed flow. The popover is a
 *  themed component (not a native control) and closes on outside tap or
 *  Escape. */
function MenuButton({ items }: {
  items: {
    label: string;
    icon?: (p: { size?: number }) => ReactNode;
    danger?: boolean;
    hide?: boolean;
    onClick: () => void;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const visible = items.filter((i) => !i.hide);

  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setArmed(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(timer.current);
    };
  }, [open]);

  const fire = (i: (typeof items)[0]) => {
    if (i.danger) {
      if (armed === i.label) {
        setOpen(false);
        setArmed(null);
        i.onClick();
        return;
      }
      setArmed(i.label);
      timer.current = window.setTimeout(() => setArmed(null), 2500);
      return;
    }
    setOpen(false);
    i.onClick();
  };

  return (
    <div className="acc-menu" ref={rootRef} onPointerDown={(e) => e.stopPropagation()}>
      <button
        className="menu-toggle"
        aria-label="Account actions"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IDots size={18} />
      </button>
      {open && visible.length > 0 && (
        <div className="menu-pop" role="menu">
          {visible.map((i) => {
            const Icon = i.icon;
            const armedNow = armed === i.label;
            return (
              <button
                key={i.label}
                role="menuitem"
                className={`menu-item${i.danger ? ' danger' : ''}${armedNow ? ' armed' : ''}`}
                onClick={() => fire(i)}
              >
                {Icon && <Icon size={15} />}
                {i.danger && armedNow ? 'Tap again to confirm' : i.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
