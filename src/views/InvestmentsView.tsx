// ============================================================================
// Investments — Executive Portfolio Allocation, Rebalancer & Account CRUD.
// Clean 4-KPI header, Capital Rebalancer simulator, interactive Donut/Pie +
// Inspector card, Complete Portfolio Breakdown table, and tabbed Management.
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
import { AllocationPie, colorForClass, type PieSlice } from '../components/AllocationPie';
import { fxService, marketDataService } from '../services';
import { classReferenceSymbol } from '../services/marketData';
import { portfolioPnl, computeEmergency } from '../insights';
import { calibrateRoboSleeves, valueInBase } from '../ai/portfolio';
import type { AccountLine } from '../ai/portfolio';
import { CURRENCIES, currencyInfo, EMERGENCY_DEFAULT, FAMED_STRATEGIES, formatMoney } from '../domain/enums';
import { ThemedSelect } from '../components/ThemedSelect';
import { IRefresh, IPlus, IPencil, IDots, ICheck } from '../icons';
import type { InvestmentAccount, InvestmentHolding } from '../domain/types';

const ASSET_CLASSES = ['equity-us', 'equity-local', 'etf', 'crypto', 'gold', 'cash', 'mmf'] as const;
const PAR_CLASSES: InvestmentHolding['assetClass'][] = ['cash', 'mmf'];
const isParClass = (c: InvestmentHolding['assetClass']) => PAR_CLASSES.includes(c);

const parSymbolFor = (c: InvestmentHolding['assetClass']) =>
  c === 'cash' ? 'CASH' : c === 'mmf' ? 'MMF' : c.toUpperCase();

type PortfolioSection = 'satellite' | 'cash' | 'more';
const sectionForType = (t: InvestmentAccount['accountType']): PortfolioSection =>
  t === 'robo' ? 'satellite' : t === 'cash' ? 'cash' : 'more';
const SECTION_META: Record<PortfolioSection, { title: string; subtitle: string }> = {
  satellite: { title: 'Satellite', subtitle: 'Robo-advisor & target strategies' },
  cash: { title: 'Cash & Reserves', subtitle: 'Liquid cash & money market' },
  more: { title: 'Direct Brokers & Crypto', subtitle: 'Equities, ETFs & digital assets' },
};

const BUCKET_PALETTE = ['#4f46e5', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ec4899', '#64748b'];

function DailyChangePill({ delta, base }: { delta: number | null; base: string }) {
  if (delta == null) return null;
  if (delta === 0) return <span className="pill-flat" title="No change since yesterday">—</span>;
  const up = delta > 0;
  return (
    <span className={`pill-daily ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {up ? '+' : '−'}{formatMoney(Math.abs(delta), base)}
      <span className="pill-sub"> today</span>
    </span>
  );
}

export function InvestmentsView() {
  const store = useVaultStore();
  const live = useLiveData();
  const { toast } = useToast();
  const { vault } = store;
  if (!vault) return null;
  const base = vault.prefs.baseCurrency;

  // ---- Display & Simulator controls (mirroring reference UI) ----
  const [displayCur, setDisplayCur] = useState<string>(base);
  useEffect(() => { setDisplayCur(base); }, [base]);

  const displayCurrencies = useMemo(() => {
    const candidates = [base, 'USD', 'MYR', 'IDR', 'SGD'];
    const uniq: string[] = [];
    for (const c of candidates) {
      if (!uniq.includes(c)) uniq.push(c);
      if (uniq.length === 3) break;
    }
    return uniq;
  }, [base]);

  const convertFromBase = (amountBase: number, targetCur: string): number => {
    if (targetCur === base || !live.fx) return amountBase;
    try {
      const oneTargetInBase = fxService.toBase(1, targetCur, live.fx);
      return oneTargetInBase > 0 ? amountBase / oneTargetInBase : amountBase;
    } catch {
      return amountBase;
    }
  };
  const fmtDisplay = (amountBase: number) =>
    formatMoney(convertFromBase(amountBase, displayCur), displayCur);

  const [chartMode, setChartMode] = useState<'donut' | 'pie'>('donut');
  const [activePie, setActivePie] = useState<'account' | 'class' | 'holding'>('account');
  const [selectedSlice, setSelectedSlice] = useState<string | null>(null);
  const [manageTab, setManageTab] = useState<'accounts' | 'add' | 'tools'>('accounts');

  // Rebalancer simulator
  const [deployEnabled, setDeployEnabled] = useState(false);
  const [newCapitalStr, setNewCapitalStr] = useState('5000');
  const [targetPrimaryPct, setTargetPrimaryPct] = useState(85);
  const newCapitalBase = useMemo(() => {
    const n = parseFloat(newCapitalStr);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [newCapitalStr]);

  // ---- Account + Holding form state ----
  const [platform, setPlatform] = useState('');
  const [acctType, setAcctType] = useState<InvestmentAccount['accountType']>('broker');
  const [deposit, setDeposit] = useState('');
  const [roboCurrentStart, setRoboCurrentStart] = useState('');
  const [accountId, setAccountId] = useState('');
  const [symbol, setSymbol] = useState('');
  const [assetClass, setAssetClass] = useState<InvestmentHolding['assetClass']>('equity-us');
  const [holdCur, setHoldCur] = useState(base);
  const [units, setUnits] = useState('');
  const [entry, setEntry] = useState('');
  const [amount, setAmount] = useState('');
  const [roboSleevePct, setRoboSleevePct] = useState('');
  const [editHolding, setEditHolding] = useState<InvestmentHolding | null>(null);
  const parMode = isParClass(assetClass);

  // Auto-select a sensible target account for Step 2 when accounts exist and
  // no valid target is chosen yet (prefer non-robo accounts, since StashAway
  // portfolios already create their sleeves in Step 1).
  useEffect(() => {
    if (vault.accounts.length === 0) return;
    if (accountId && vault.accounts.some((a) => a.id === accountId)) return;
    const preferred = vault.accounts.find((a) => a.accountType !== 'robo') ?? vault.accounts[0];
    if (preferred) setAccountId(preferred.id);
  }, [vault.accounts, accountId]);

  const [saRefs, setSaRefs] = useState<Record<string, number>>({});
  const [roboRows, setRoboRows] = useState<{ assetClass: InvestmentHolding['assetClass']; pct: string; ticker: string }[]>([
    { assetClass: 'equity-us', pct: '60', ticker: '' },
    { assetClass: 'gold', pct: '20', ticker: '' },
    { assetClass: 'cash', pct: '20', ticker: '' },
  ]);
  const isRobo = acctType === 'robo';
  /**
   * Seed the reference price for a sleeve.
   * When the row has a custom ticker the quote engine fetches THAT instrument
   * (so refPrice anchors to CSPX, GLD, QQQ, etc., not the broad index).
   * Cache key is `TICKER` when set, or `assetClass` otherwise, so changing
   * the ticker field triggers a fresh fetch and overwrites the stale ref.
   */
  const seedRoboRefs = async (rows: { assetClass: string; ticker: string }[]) => {
    await Promise.all(
      rows.map(async (r) => {
        const cacheKey = (r.ticker && r.ticker.trim()) ? r.ticker.trim().toUpperCase() : r.assetClass;
        if (saRefs[cacheKey] && saRefs[cacheKey] > 0) return;
        try {
          let p = 0;
          if (r.ticker && r.ticker.trim()) {
            // Build a synthetic holding so the existing quote() routing handles
            // crypto (CoinGecko) vs equity/ETF/gold (Yahoo) automatically.
            const q = await marketDataService.quote({
              id: '__ref__', accountId: '', symbol: r.ticker.trim().toUpperCase(),
              assetClass: r.assetClass as InvestmentHolding['assetClass'],
              holdingCurrency: base, units: 1, averageEntryPrice: 1,
              currentPriceLocal: 0, currentPriceBase: 0,
            });
            p = Number.isFinite(q.price) && q.price > 0 ? q.price : 0;
          } else {
            p = await marketDataService.referencePriceFor(r.assetClass, base);
          }
          if (p > 0) setSaRefs((prev) => ({ ...prev, [cacheKey]: p }));
        } catch { /* offline */ }
      }),
    );
  };
  useEffect(() => {
    if (isRobo) void seedRoboRefs(roboRows.map((r) => ({ assetClass: r.assetClass, ticker: r.ticker })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRobo]);

  const pickAssetClass = (c: InvestmentHolding['assetClass']) => {
    setAssetClass(c);
    if (isParClass(c)) setSymbol(parSymbolFor(c));
  };

  // ---- Live portfolio computations ----
  const accLines = useMemo(() => {
    const m = new Map<string, AccountLine>();
    if (live.portfolio) for (const a of live.portfolio.byAccount) m.set(a.account.id, a);
    return m;
  }, [live.portfolio]);

  const dailyChange = useMemo(() => {
    const m = new Map<string, number | null>();
    const hist = vault.accountHistory ?? {};
    for (const [accId, pts] of Object.entries(hist)) {
      if (pts.length < 2) { m.set(accId, null); continue; }
      const today = pts[pts.length - 1];
      const yesterday = pts[pts.length - 2];
      m.set(accId, today.valueBase - yesterday.valueBase);
    }
    return m;
  }, [vault.accountHistory]);

  const lastCaptured = useRef<string>('');
  useEffect(() => {
    if (!live.portfolio) return;
    const values: Record<string, number> = {};
    for (const line of live.portfolio.byAccount) {
      values[line.account.id] = Math.round(line.valueBase * 100) / 100;
    }
    const sig = JSON.stringify(values);
    if (sig === lastCaptured.current) return;
    lastCaptured.current = sig;
    store.captureAccountValues(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.portfolio]);

  // Auto-heal non-par allocation sleeves created while offline (refPrice <= 1):
  // once a live quote lands, anchor refPrice + refFxRate so future market
  // and FX moves calculate P&L automatically without needing to recreate.
  useEffect(() => {
    for (const h of vault.holdings) {
      if (!h.isAllocation || isParClass(h.assetClass)) continue;
      if (Number.isFinite(h.refPrice) && (h.refPrice ?? 0) > 1) continue;
      const q = live.quotes[h.symbol];
      if (q && (q.source === 'yahoo' || q.source === 'coingecko') && Number.isFinite(q.price) && q.price > 1) {
        const curFx = q.currency === base ? 1 : (live.fx ? fxService.toBase(1, q.currency, live.fx) : 0);
        store.updateHolding(h.id, {
          refPrice: q.price,
          ...(q.currency !== base && curFx > 0 ? { refFxRate: curFx } : {}),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.quotes, live.fx, vault.holdings]);

  const pnl = useMemo(() => {
    if (!live.portfolio) return null;
    return portfolioPnl(live.portfolio, vault.accounts, vault.contributions ?? []);
  }, [live.portfolio, vault.accounts, vault.contributions]);

  const reservedIds = useMemo(
    () => new Set((vault.emergency?.items ?? []).filter((i) => i.kind === 'account' && i.accountId).map((i) => i.accountId!)),
    [vault.emergency],
  );

  const emRes = useMemo(
    () =>
      computeEmergency({
        emergency: vault.emergency ?? EMERGENCY_DEFAULT,
        expenses: vault.expenses,
        accounts: vault.accounts,
        portfolio: live.portfolio,
        fx: live.fx,
        base,
        now: Date.now(),
      }),
    [vault, live.portfolio, live.fx, base],
  );

  // De-duplicated account lines (non-sleeve) for KPIs, breakdown table, and rebalancer
  const accountRows = useMemo(() => {
    const lines = pnl?.accounts ?? [];
    return lines
      .filter((l) => !l.account.isSubView)
      .map((l, idx) => {
        const isEmergency = reservedIds.has(l.account.id) || l.account.accountType === 'cash';
        const deposit = l.capitalBase > 0 ? l.capitalBase : l.costBase;
        const val = l.valueBase;
        const profit = deposit > 0 ? val - deposit : null;
        const retPct = deposit > 0 && profit != null ? (profit / deposit) * 100 : null;
        return {
          account: l.account,
          isEmergency,
          depositBase: deposit,
          valueBase: val,
          pnlBase: profit,
          retPct,
          color: BUCKET_PALETTE[idx % BUCKET_PALETTE.length],
        };
      });
  }, [pnl, reservedIds]);

  const investRows = useMemo(() => accountRows.filter((r) => !r.isEmergency), [accountRows]);
  const emergencyRows = useMemo(() => accountRows.filter((r) => r.isEmergency), [accountRows]);

  // Rebalancer plan between the top 2 investment accounts (or classes)
  const rebalancerPlan = useMemo(() => {
    const sorted = [...investRows].sort((a, b) => b.valueBase - a.valueBase);
    const primary = sorted[0] ?? null;
    const secondary = sorted[1] ?? null;
    if (!primary || !secondary) return null;
    const pVal = primary.valueBase;
    const sVal = secondary.valueBase;
    const postTotal = pVal + sVal + newCapitalBase;
    const targetP = (targetPrimaryPct / 100) * postTotal;
    let addPrimary = Math.max(0, Math.min(newCapitalBase, targetP - pVal));
    let addSecondary = Math.max(0, newCapitalBase - addPrimary);
    return {
      primary,
      secondary,
      addPrimary,
      addSecondary,
      postPrimary: pVal + addPrimary,
      postSecondary: sVal + addSecondary,
      postTotal,
      postPrimaryPct: postTotal > 0 ? ((pVal + addPrimary) / postTotal) * 100 : 0,
      postSecondaryPct: postTotal > 0 ? ((sVal + addSecondary) / postTotal) * 100 : 0,
    };
  }, [investRows, newCapitalBase, targetPrimaryPct]);

  const deployDeltaFor = (accId: string): number => {
    if (!deployEnabled || !rebalancerPlan) return 0;
    if (accId === rebalancerPlan.primary.account.id) return rebalancerPlan.addPrimary;
    if (accId === rebalancerPlan.secondary.account.id) return rebalancerPlan.addSecondary;
    return 0;
  };

  // Totals (include simulated new capital when switch is ON)
  const simAddTotal = deployEnabled && rebalancerPlan ? newCapitalBase : 0;
  const totalCurrentBase = useMemo(
    () => accountRows.reduce((s, r) => s + r.valueBase, 0) + simAddTotal,
    [accountRows, simAddTotal],
  );
  const totalDepositBase = useMemo(
    () => accountRows.reduce((s, r) => s + r.depositBase, 0) + simAddTotal,
    [accountRows, simAddTotal],
  );
  const totalPnlBase = totalDepositBase > 0 ? totalCurrentBase - totalDepositBase : null;
  const totalPnlPct = totalDepositBase > 0 && totalPnlBase != null ? (totalPnlBase / totalDepositBase) * 100 : null;

  const investTotalBase = useMemo(
    () => investRows.reduce((s, r) => s + r.valueBase, 0) + simAddTotal,
    [investRows, simAddTotal],
  );
  const emergencyTotalBase = useMemo(
    () => emergencyRows.reduce((s, r) => s + r.valueBase, 0),
    [emergencyRows],
  );
  const emergencyRatioBase = emergencyTotalBase > 0 ? emergencyTotalBase : emRes.reserve;
  const splitDenom = investTotalBase + emergencyRatioBase;
  const investSharePct = splitDenom > 0 ? (investTotalBase / splitDenom) * 100 : 0;
  const emergencySharePct = splitDenom > 0 ? 100 - investSharePct : 0;

  // Pie slices for AllocationPie
  const rateToBase = (code: string): number =>
    live.fx ? fxService.toBase(1, code, live.fx) : code === base ? 1 : 0;

  const pieSlices = useMemo<PieSlice[]>(() => {
    if (activePie === 'account') {
      return accountRows
        .map((r) => ({
          key: r.account.id,
          label: r.account.platformName,
          valueBase: r.valueBase + deployDeltaFor(r.account.id),
          color: r.color,
        }))
        .filter((s) => s.valueBase > 0);
    }
    if (activePie === 'holding') {
      return vault.holdings
        .map((h) => {
          const q = live.quotes[h.symbol];
          const { valueBase, ok } = valueInBase(h, q, base, rateToBase);
          return {
            key: h.id,
            label: h.symbol,
            valueBase: ok ? valueBase : 0,
            color: colorForClass(h.assetClass, 0),
          };
        })
        .filter((s) => s.valueBase > 0);
    }
    const byClass = new Map<string, { valueBase: number; sub: { label: string; valueBase: number }[] }>();
    for (const h of vault.holdings) {
      const q = live.quotes[h.symbol];
      const { valueBase, ok } = valueInBase(h, q, base, rateToBase);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePie, accountRows, vault.holdings, live.quotes, live.fx, base, deployEnabled, rebalancerPlan]);

  const totalPieValue = useMemo(() => pieSlices.reduce((s, x) => s + x.valueBase, 0), [pieSlices]);

  // Selected slice details for Inspector card
  const inspector = useMemo(() => {
    const slice = selectedSlice ? pieSlices.find((s) => s.key === selectedSlice) ?? null : null;
    if (!slice) {
      return {
        tag: 'Overall View',
        title: `Combined Portfolio (${accountRows.length} ${accountRows.length === 1 ? 'Bucket' : 'Buckets'})`,
        subtitle: vault.holdings.length > 0
          ? `${vault.holdings.length} holdings across ${vault.accounts.length} accounts`
          : 'No holdings tracked yet',
        sharePct: totalPieValue > 0 ? 100 : 0,
        valueBase: totalCurrentBase,
        depositBase: totalDepositBase,
        pnlBase: totalPnlBase,
        retPct: totalPnlPct,
      };
    }
    const accRow = activePie === 'account' ? accountRows.find((r) => r.account.id === slice.key) : null;
    const val = slice.valueBase;
    const dep = accRow ? accRow.depositBase + deployDeltaFor(accRow.account.id) : 0;
    const profit = dep > 0 ? val - dep : null;
    const ret = dep > 0 && profit != null ? (profit / dep) * 100 : null;
    return {
      tag: accRow ? (accRow.isEmergency ? 'Emergency Buffer' : 'Investment Account') : activePie === 'holding' ? 'Holding' : 'Asset Class',
      title: slice.label,
      subtitle: accRow ? accRow.account.accountType : `${((val / (totalPieValue || 1)) * 100).toFixed(1)}% of portfolio`,
      sharePct: totalPieValue > 0 ? (val / totalPieValue) * 100 : 0,
      valueBase: val,
      depositBase: dep,
      pnlBase: profit,
      retPct: ret,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlice, pieSlices, activePie, accountRows, totalPieValue, totalCurrentBase, totalDepositBase, totalPnlBase, totalPnlPct, vault.holdings.length, vault.accounts.length]);

  const otherCurrenciesLine = (amountBase: number) => {
    const others = ['USD', 'MYR', 'EUR', 'SGD', 'IDR'].filter((c) => c !== displayCur).slice(0, 2);
    return others.map((c) => `${formatMoney(convertFromBase(amountBase, c), c)} ${c}`).join(' • ');
  };

  // ---- CRUD handlers ----
  const fetchSleeveQuote = async (
    assetClassName: InvestmentHolding['assetClass'],
    tickerStr: string,
  ): Promise<{ price: number; currency: string }> => {
    const cleanTicker = tickerStr.trim().toUpperCase();
    try {
      if (cleanTicker) {
        const q = await marketDataService.quote({
          id: '__ref__', accountId: '', symbol: cleanTicker,
          assetClass: assetClassName,
          holdingCurrency: base, units: 1, averageEntryPrice: 1,
          currentPriceLocal: 0, currentPriceBase: 0,
        });
        return {
          price: Number.isFinite(q.price) && q.price > 0 ? q.price : 0,
          currency: q.currency || base,
        };
      }
      const p = await marketDataService.referencePriceFor(assetClassName, base);
      return { price: p, currency: base };
    } catch {
      return { price: 0, currency: base };
    }
  };

  const addAccount = async () => {
    const name = platform.trim();
    if (!name) return;
    const d = parseFloat(deposit);
    const depositOk = Number.isFinite(d) && d > 0;
    const curStart = parseFloat(roboCurrentStart);
    const curStartOk = Number.isFinite(curStart) && curStart > 0;
    if (isRobo) {
      const validRows = roboRows.filter((r) => Number.isFinite(parseFloat(r.pct)) && parseFloat(r.pct) > 0);
      if (validRows.length === 0) {
        toast('Pick at least one asset to allocate to');
        return;
      }
      const rates = live.fx ?? (await fxService.latest(base).catch(() => null));
      const rawSleeves = await Promise.all(
        validRows.map(async (r, idx) => {
          const cleanTicker = r.ticker.trim().toUpperCase();
          const cacheKey = cleanTicker || r.assetClass;
          let ref = saRefs[cacheKey] || 0;
          let quoteCur = base;
          if (!isParClass(r.assetClass)) {
            const q = await fetchSleeveQuote(r.assetClass, cleanTicker);
            if (q.price > 0) {
              ref = q.price;
              quoteCur = q.currency;
              setSaRefs((prev) => ({ ...prev, [cacheKey]: q.price }));
            }
          }
          const curFx = quoteCur === base ? 1 : (rates ? fxService.toBase(1, quoteCur, rates) : 0);
          return {
            id: `tmp-${idx}`,
            assetClass: r.assetClass,
            allocationPct: parseFloat(r.pct),
            refPrice: ref,
            refFxRate: quoteCur !== base && Number.isFinite(curFx) && curFx > 0 ? curFx : undefined,
            quoteCurrency: quoteCur,
            curFxRate: Number.isFinite(curFx) ? curFx : 0,
            ticker: cleanTicker || undefined,
          };
        }),
      );
      if (depositOk && curStartOk) {
        const patches = calibrateRoboSleeves(
          rawSleeves.map((s) => ({
            id: s.id,
            assetClass: s.assetClass,
            allocationPct: s.allocationPct,
            livePrice: s.refPrice,
            refPrice: s.refPrice,
            quoteCurrency: s.quoteCurrency,
            curFxRate: s.curFxRate,
          })),
          d,
          curStart,
          base,
        );
        if (patches) {
          const byId = new Map(patches.map((p) => [p.id, p]));
          for (const s of rawSleeves) {
            const p = byId.get(s.id);
            if (p) {
              s.refPrice = p.refPrice;
              s.refFxRate = p.refFxRate;
            }
          }
        }
      }
      const sleeves = rawSleeves.map(({ assetClass: ac, allocationPct, refPrice, refFxRate, ticker }) => ({
        assetClass: ac,
        allocationPct,
        refPrice,
        refFxRate,
        ticker,
      }));
      const id = store.addAllocationPortfolio({
        platformName: name,
        netDepositBase: depositOk ? d : 0,
        holdingCurrency: base,
        sleeves,
      });
      setAccountId(id);
      setPlatform('');
      setDeposit('');
      setRoboCurrentStart('');
      toast(
        depositOk && curStartOk
          ? `Created & calibrated ${name} to ${formatMoney(curStart, base)} — future moves track live prices`
          : `Created ${name} — ${sleeves.length} asset${sleeves.length > 1 ? 's' : ''} tracking live prices`,
      );
      return;
    }
    const id = store.addAccount({
      platformName: name,
      accountType: acctType,
    });
    setAccountId(id);
    setPlatform('');
    setDeposit('');
    toast(`Account "${name}" created and set as target`);
  };

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

  const unReserve = (id: string) => {
    const removed = (vault.emergency?.items ?? []).filter(
      (i) => i.kind === 'account' && i.accountId === id,
    );
    if (removed.length === 0) return;
    for (const item of removed) store.deleteEmergencyItem(item.id);
    toast(`Removed "${vault.accounts.find((a) => a.id === id)?.platformName ?? 'account'}" from the reserve.`);
  };

  const addHolding = async () => {
    const par = isParClass(assetClass);
    const am = parseFloat(amount);
    if (par && (!accountId || !isFinite(am) || am <= 0)) return;
    const u = parseFloat(units);
    const e = parseFloat(entry);
    if (!par && (!accountId || !symbol.trim() || !isFinite(u) || u <= 0)) return;
    const finalUnits = par ? am : u;
    const finalEntry = par ? 1 : e;
    const finalSymbol = (par ? parSymbolFor(assetClass) : symbol.trim()).toUpperCase();
    let local = par ? 1 : e || 0;
    let priceBase = local;
    try {
      const rates = await fxService.latest(base);
      if (holdCur !== base) {
        const r = fxService.toBase(1, holdCur, rates);
        priceBase = Number.isFinite(r) ? local * r : 0;
      }
    } catch { /* offline */ }
    store.addHolding({
      accountId,
      symbol: finalSymbol,
      assetClass,
      holdingCurrency: holdCur,
      units: finalUnits,
      averageEntryPrice: finalEntry,
      currentPriceLocal: local || undefined,
      currentPriceBase: priceBase || undefined,
    });
    setSymbol(''); setUnits(''); setEntry(''); setAmount('');
    toast(`Added ${finalSymbol} to target account`);
  };

  const targetAcct = vault.accounts.find((a) => a.id === accountId) ?? null;
  const targetIsRobo = targetAcct?.accountType === 'robo';

  const addRoboSleeve = async () => {
    const pct = parseFloat(roboSleevePct);
    if (!accountId || !Number.isFinite(pct) || pct <= 0) {
      toast('Enter an allocation % greater than 0.', 'err');
      return;
    }
    const cleanTicker = symbol.trim().toUpperCase();
    const sym = cleanTicker || classReferenceSymbol(assetClass);
    const par = isParClass(assetClass);
    let ref = par ? 1 : 0;
    let refFxRate: number | undefined;
    if (!par) {
      const rates = live.fx ?? (await fxService.latest(base).catch(() => null));
      const q = await fetchSleeveQuote(assetClass, cleanTicker);
      if (q.price > 0) {
        ref = q.price;
        const curFx = q.currency === base ? 1 : (rates ? fxService.toBase(1, q.currency, rates) : 0);
        if (q.currency !== base && Number.isFinite(curFx) && curFx > 0) refFxRate = curFx;
      }
    }
    const dep = targetAcct?.initialDepositBase ?? 0;
    const sliceBase = (pct / 100) * dep;
    store.addHolding({
      accountId,
      symbol: sym,
      assetClass,
      holdingCurrency: base,
      units: sliceBase,
      averageEntryPrice: 1,
      currentPriceLocal: 1,
      currentPriceBase: 1,
      isAllocation: true,
      allocationPct: pct,
      refPrice: ref,
      ...(refFxRate ? { refFxRate } : {}),
    });
    setSymbol('');
    setRoboSleevePct('');
    toast(`Added ${sym} (${pct}%) sleeve to ${targetAcct!.platformName}`);
  };

  // ---- Modals state ----
  const [mSymbol, setMSymbol] = useState('');
  const [mClass, setMClass] = useState<InvestmentHolding['assetClass']>('equity-us');
  const [mCur, setMCur] = useState(base);
  const [mUnits, setMUnits] = useState('');
  const [mEntry, setMEntry] = useState('');
  const [mAmount, setMAmount] = useState('');
  const [mValue, setMValue] = useState('');
  const [mIsRobo, setMIsRobo] = useState(false);
  const [mIsAlloc, setMIsAlloc] = useState(false);
  const [mAllocPct, setMAllocPct] = useState('');
  const mPar = isParClass(mClass);

  const openEdit = (h: InvestmentHolding) => {
    setMSymbol(h.symbol);
    setMClass(h.assetClass);
    setMCur(h.holdingCurrency);
    const acct = vault.accounts.find((a) => a.id === h.accountId);
    const isAlloc = Boolean(h.isAllocation);
    const robo = !isAlloc && acct?.accountType === 'robo' && !isParClass(h.assetClass);
    setMIsAlloc(isAlloc);
    setMIsRobo(robo);
    if (isAlloc) {
      setMAllocPct(String(h.allocationPct ?? 0));
    } else if (robo) {
      const v = (Number.isFinite(h.currentPriceLocal) ? h.currentPriceLocal : h.averageEntryPrice) * (Number.isFinite(h.units) ? h.units : 1);
      setMValue(String(Math.round(v * 100) / 100));
    } else if (isParClass(h.assetClass)) {
      setMAmount(String(h.units));
    } else {
      setMUnits(String(h.units));
      setMEntry(String(h.averageEntryPrice));
    }
    setEditHolding(h);
  };
  const closeEdit = () => setEditHolding(null);

  const [depOpen, setDepOpen] = useState(false);
  const [depFocusId, setDepFocusId] = useState<string | null>(null);
  const openDeposit = (focusAccountId?: string) => {
    setDepFocusId(focusAccountId ?? null);
    setDepOpen(true);
  };

  const [costOpen, setCostOpen] = useState(false);
  const [costDrafts, setCostDrafts] = useState<Record<string, string>>({});
  const [brokerValueDrafts, setBrokerValueDrafts] = useState<Record<string, string>>({});
  const openCostBasis = () => {
    const seeds: Record<string, string> = {};
    const brokerSeeds: Record<string, string> = {};
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
      const broker = Number.isFinite(a.brokerValueBase) && (a.brokerValueBase ?? 0) > 0
        ? String(Math.round(a.brokerValueBase! * 100) / 100)
        : (line && line.valueBase > 0 ? String(Math.round(line.valueBase * 100) / 100) : '');
      brokerSeeds[a.id] = broker;
    }
    setCostDrafts(seeds);
    setBrokerValueDrafts(brokerSeeds);
    setCostOpen(true);
  };

  const saveCostBasis = async () => {
    let touched = 0;
    let brokerSet = 0;
    let calibrated = 0;
    const rates = live.fx ?? (await fxService.latest(base).catch(() => null));
    for (const a of vault.accounts) {
      const raw = (costDrafts[a.id] ?? '').trim();
      const totalInvested = parseFloat(raw);
      const braw = (brokerValueDrafts[a.id] ?? '').trim();
      const brokerVal = parseFloat(braw);
      const patch: Partial<InvestmentAccount> = {};
      const depositValid = raw !== '' && Number.isFinite(totalInvested) && totalInvested > 0;
      const acctAllocSleeves = a.accountType === 'robo'
        ? vault.holdings.filter((h) => h.accountId === a.id && h.isAllocation)
        : [];
      let didCalibrate = false;

      if (braw !== '' && Number.isFinite(brokerVal) && brokerVal > 0 && acctAllocSleeves.length > 0) {
        const depositForCalib = depositValid ? totalInvested : (a.initialDepositBase ?? 0);
        if (depositForCalib > 0) {
          const needBatch = acctAllocSleeves.some((s) => !isParClass(s.assetClass) && !(live.quotes[s.symbol]?.price > 0));
          const freshQuotes = needBatch ? await marketDataService.batch(acctAllocSleeves).catch(() => ({} as typeof live.quotes)) : {};
          const mergedQuotes = { ...live.quotes, ...freshQuotes };
          const patches = calibrateRoboSleeves(
            acctAllocSleeves.map((s) => {
              const q = mergedQuotes[s.symbol];
              const qCur = isParClass(s.assetClass) ? s.holdingCurrency : (q?.currency ?? s.holdingCurrency);
              const curFx = qCur === base ? 1 : (rates ? fxService.toBase(1, qCur, rates) : 0);
              return {
                id: s.id,
                assetClass: s.assetClass,
                allocationPct: s.allocationPct ?? 0,
                livePrice: q && Number.isFinite(q.price) && q.price > 0 ? q.price : 0,
                refPrice: Number.isFinite(s.refPrice) && (s.refPrice ?? 0) > 1 ? s.refPrice! : 0,
                quoteCurrency: qCur,
                curFxRate: Number.isFinite(curFx) ? curFx : 0,
              };
            }),
            depositForCalib,
            brokerVal,
            base,
          );
          if (patches) {
            for (const p of patches) {
              store.updateHolding(p.id, { refPrice: p.refPrice, refFxRate: p.refFxRate });
            }
            // Clear any static brokerValueBase so live ticker + FX moves track StashAway automatically from here on.
            if (a.brokerValueBase != null) patch.brokerValueBase = undefined;
            didCalibrate = true;
            calibrated++;
          }
        }
      }

      if (!didCalibrate) {
        if (braw !== '' && Number.isFinite(brokerVal) && brokerVal > 0) {
          patch.brokerValueBase = brokerVal;
          brokerSet++;
        } else if (a.brokerValueBase != null) {
          patch.brokerValueBase = undefined;
        }
      }

      if (depositValid) {
        const line = live.portfolio?.byAccount.find((l) => l.account.id === a.id);
        const acctValue = braw !== '' && Number.isFinite(brokerVal) && brokerVal > 0
          ? brokerVal
          : (line?.valueBase ?? 0);
        if (acctValue > 0 && totalInvested > acctValue * 1.05) {
          toast(`Heads-up: "${a.platformName}" total invested exceeds its value by ${(totalInvested / acctValue).toFixed(1)}×.`, 'warn');
        }
        patch.initialDepositBase = totalInvested;
        const distributable = (line?.lines ?? []).filter(
          (l) => !l.holding.isAllocation && !isParClass(l.holding.assetClass) && l.valueBase > 0 && Number.isFinite(l.holding.units) && l.holding.units > 0,
        );
        const totalDistValue = distributable.reduce((s, l) => s + l.valueBase, 0);
        if (totalDistValue > 0) {
          for (const l of distributable) {
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
      if (Object.keys(patch).length > 0) store.updateAccount(a.id, patch);
    }
    setCostOpen(false);
    const bits: string[] = [];
    if (calibrated > 0) bits.push(`calibrated ${calibrated} StashAway portfolio${calibrated === 1 ? '' : 's'} (auto-tracks live)`);
    if (brokerSet > 0) bits.push(`${brokerSet} broker value${brokerSet === 1 ? '' : 's'}`);
    if (touched > 0) bits.push(`${touched} holding${touched === 1 ? '' : 's'}`);
    toast(bits.length > 0 ? `Saved · ${bits.join(', ')}` : 'Cost basis saved');
  };

  useEffect(() => {
    if (!depOpen || !depFocusId) return;
    const el = document.querySelector(`[data-dep-focus="1"] .dep-input`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (el as HTMLElement).focus();
    }
  }, [depOpen, depFocusId]);

  const saveHoldingEdit = async () => {
    const h = editHolding;
    if (!h) return;
    const par = isParClass(mClass);
    if (mIsAlloc) {
      const pct = parseFloat(mAllocPct);
      if (!Number.isFinite(pct) || pct <= 0) { toast('Allocation % must be positive.', 'err'); return; }
      const newSym = mSymbol.trim().toUpperCase() || classReferenceSymbol(mClass);
      const patch: Partial<Omit<InvestmentHolding, 'id'>> = {
        symbol: newSym,
        assetClass: mClass,
        allocationPct: pct,
      };
      if (newSym !== h.symbol || mClass !== h.assetClass) {
        if (par) {
          patch.refPrice = 1;
          patch.refFxRate = undefined;
        } else {
          const rates = live.fx ?? (await fxService.latest(base).catch(() => null));
          const q = await fetchSleeveQuote(mClass, mSymbol.trim());
          if (q.price > 0) {
            patch.refPrice = q.price;
            const curFx = q.currency === base ? 1 : (rates ? fxService.toBase(1, q.currency, rates) : 0);
            patch.refFxRate = q.currency !== base && Number.isFinite(curFx) && curFx > 0 ? curFx : undefined;
          }
        }
      }
      store.updateHolding(h.id, patch);
      closeEdit();
      toast(`Updated ${newSym} (${pct}%)`);
      return;
    }
    if (mIsRobo) {
      const v = parseFloat(mValue);
      if (!isFinite(v) || v <= 0) { toast('Enter how much it is worth.', 'err'); return; }
      let priceBase = v;
      try {
        const rates = await fxService.latest(base);
        if (mCur !== base) { const r = fxService.toBase(1, mCur, rates); priceBase = Number.isFinite(r) ? v * r : v; }
      } catch { /* offline */ }
      store.updateHolding(h.id, {
        accountId: h.accountId,
        symbol: mSymbol.trim().toUpperCase() || h.symbol,
        assetClass: mClass,
        holdingCurrency: mCur,
        units: 1,
        averageEntryPrice: v,
        currentPriceLocal: v,
        currentPriceBase: priceBase,
      });
      closeEdit();
      toast(`Updated ${mSymbol.trim().toUpperCase() || h.symbol}`);
      return;
    }
    const am = parseFloat(mAmount);
    const u = parseFloat(mUnits);
    const e = parseFloat(mEntry);
    if (par && (!isFinite(am) || am <= 0)) { toast('Amount must be positive.', 'err'); return; }
    if (!par && (!mSymbol.trim() || !isFinite(u) || u <= 0)) { toast('Symbol and units required.', 'err'); return; }
    const finalUnits = par ? am : u;
    const finalEntry = par ? 1 : e;
    const finalSymbol = (par ? parSymbolFor(mClass) : mSymbol.trim()).toUpperCase();
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

  const grouped = useMemo(() => {
    const byPlat = new Map<string, InvestmentHolding[]>();
    for (const h of vault.holdings) {
      const acc = vault.accounts.find((a) => a.id === h.accountId);
      const key = acc?.platformName ?? 'Unassigned';
      byPlat.set(key, [...(byPlat.get(key) ?? []), h]);
    }
    return byPlat;
  }, [vault.holdings, vault.accounts]);

  const manageRef = useRef<HTMLDivElement>(null);
  const jumpToAdd = () => {
    setManageTab('add');
    manageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const usdToBase = live.fx ? fxService.toBase(1, 'USD', live.fx) : null;
  const baseToIdr = live.fx ? convertFromBase(1, 'IDR') : null;

  return (
    <>
      {/* ==================== PAGE HEADER & CONTROLS ==================== */}
      <div className="page-head">
        <div>
          <div className="page-badge">
            <span className="dot" />
            <span>{vault.prefs.displayName ? `${vault.prefs.displayName}'s Portfolio` : 'Personal Portfolio'}</span>
            <span>•</span>
            <span>{vault.holdings.length} holdings · {vault.accounts.length} accounts</span>
            {deployEnabled && rebalancerPlan && (
              <span className="chip sm ok" style={{ marginLeft: 4 }}>+{formatMoney(newCapitalBase, base)} Active</span>
            )}
          </div>
          <h1 className="page-title">Portfolio Allocation &amp; Rebalancer</h1>
          <p className="page-sub">
            Unified view of your investments, emergency buffer, P&amp;L, and capital deployment.
          </p>
        </div>

        <div className="page-controls">
          <div className="seg" role="group" aria-label="Display currency">
            {displayCurrencies.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={displayCur === c}
                onClick={() => setDisplayCur(c)}
              >
                {c} ({currencyInfo(c).symbol})
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Chart mode">
            <button type="button" aria-pressed={chartMode === 'donut'} onClick={() => setChartMode('donut')}>Donut</button>
            <button type="button" aria-pressed={chartMode === 'pie'} onClick={() => setChartMode('pie')}>Pie</button>
          </div>
          <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}>
            <IRefresh size={15} /> {live.loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn sm" onClick={jumpToAdd}>
            <IPlus size={15} /> Add Account / Holding
          </button>
        </div>
      </div>

      {/* ==================== FX RATES INLINE BAR ==================== */}
      <div className="fx-bar">
        <div className="fx-bar-title">
          <span className="fx-bar-dot" />
          <span>{live.fxSource === 'offline' ? 'FX Snapshot (Offline Fallback):' : 'Live FX Rates:'}</span>
        </div>
        <div className="fx-bar-pills">
          {usdToBase != null && Number.isFinite(usdToBase) && base !== 'USD' && (
            <span className="fx-chip">1 USD = <strong>{usdToBase.toFixed(4)}</strong> {base}</span>
          )}
          {baseToIdr != null && Number.isFinite(baseToIdr) && base !== 'IDR' && (
            <span className="fx-chip">1 {base} = <strong className="pos">{baseToIdr.toFixed(2)}</strong> IDR</span>
          )}
          <span className="fx-chip">Live quotes: <strong>{live.portfolio?.liveQuoteCount ?? 0}</strong></span>
          {vault.accounts.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => openCostBasis()}>
              Match Broker Value
            </button>
          )}
        </div>
      </div>

      {/* ==================== 4 TOP KPI CARDS ==================== */}
      <section className="kpi-grid-4" aria-label="Portfolio KPI Summary">
        <div className="kpi-card">
          <div className="kpi-card-top">
            <p className="kpi-card-lbl">Total Portfolio Value</p>
            <span className="kpi-tag">{deployEnabled && rebalancerPlan ? 'Projected' : 'Current'}</span>
          </div>
          <p className="kpi-card-val">{fmtDisplay(totalCurrentBase)}</p>
          <p className="kpi-card-sub">{otherCurrenciesLine(totalCurrentBase)}</p>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-top">
            <p className="kpi-card-lbl">Total Net Deposits</p>
          </div>
          <p className="kpi-card-val">{fmtDisplay(totalDepositBase)}</p>
          <p className="kpi-card-sub">{otherCurrenciesLine(totalDepositBase)}</p>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-top">
            <p className="kpi-card-lbl">Total Net Profit / Loss</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <p
              className="kpi-card-val"
              style={{
                marginTop: 0,
                color: totalPnlBase == null ? 'var(--muted)' : totalPnlBase >= 0 ? 'var(--good)' : 'var(--bad)',
              }}
            >
              {totalPnlBase != null
                ? `${totalPnlBase >= 0 ? '+' : '−'}${fmtDisplay(Math.abs(totalPnlBase))}`
                : '—'}
            </p>
            {totalPnlPct != null && (
              <span className={`kpi-pct-pill ${totalPnlPct >= 0 ? 'up' : 'down'}`}>
                {totalPnlPct >= 0 ? '+' : '−'}{Math.abs(totalPnlPct).toFixed(2)}%
              </span>
            )}
          </div>
          <p className="kpi-card-sub">
            {totalPnlBase != null ? otherCurrenciesLine(totalPnlBase) : 'Add holdings & deposits to track P&L'}
          </p>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-top">
            <p className="kpi-card-lbl">Investments vs. Emergency</p>
          </div>
          <p className="kpi-card-val" style={{ color: 'var(--good)' }}>
            {splitDenom > 0 ? `${investSharePct.toFixed(1)}% / ${emergencySharePct.toFixed(1)}%` : '0% / 0%'}
          </p>
          <p className="kpi-card-sub">
            Emergency Buffer: {fmtDisplay(emergencyRatioBase)}
          </p>
        </div>
      </section>

      {/* ==================== CAPITAL DEPLOYMENT REBALANCER ==================== */}
      {rebalancerPlan && (
        <section className="rebalancer-card" aria-label="New Investment Rebalancer">
          <div className="rebalancer-bar" />
          <div className="rebalancer-head">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>New Investment Rebalancer</h2>
                <span className={`kpi-tag`}>{deployEnabled ? 'Simulation Active' : 'Preview Only'}</span>
              </div>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                Split fresh capital between <strong>{rebalancerPlan.primary.account.platformName}</strong> and{' '}
                <strong>{rebalancerPlan.secondary.account.platformName}</strong> toward your target ratio.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={deployEnabled}
              className="switch-pill"
              onClick={() => setDeployEnabled((v) => !v)}
            >
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>Simulate Deploying Capital</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {deployEnabled ? `ON — Previewing +${formatMoney(newCapitalBase, base)}` : 'OFF — Showing current snapshot'}
                </div>
              </div>
              <span className="switch-track"><span className="switch-thumb" /></span>
            </button>
          </div>

          <div className="rebalancer-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="grid-2">
                <div className="subpanel">
                  <label className="small muted" style={{ fontWeight: 700, display: 'block', marginBottom: 6 }}>
                    NEW CAPITAL ({base})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={newCapitalStr}
                    onChange={(e) => setNewCapitalStr(e.target.value)}
                    aria-label="New capital to deploy"
                  />
                </div>
                <div className="subpanel">
                  <span className="small muted" style={{ fontWeight: 700, display: 'block', marginBottom: 6 }}>
                    TARGET SPLIT
                  </span>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div>
                      <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, display: 'block' }}>
                        {rebalancerPlan.primary.account.platformName}
                      </span>
                      <span className="font-display" style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)' }}>
                        {targetPrimaryPct.toFixed(0)}%
                      </span>
                    </div>
                    <span className="muted">/</span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700, display: 'block' }}>
                        {rebalancerPlan.secondary.account.platformName}
                      </span>
                      <span className="font-display" style={{ fontSize: 20, fontWeight: 800, color: '#f59e0b' }}>
                        {(100 - targetPrimaryPct).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="row small" style={{ marginBottom: 6 }}>
                  <span className="muted">Target {rebalancerPlan.primary.account.platformName} Share</span>
                  <strong style={{ color: 'var(--accent)' }}>{targetPrimaryPct}% / {100 - targetPrimaryPct}%</strong>
                </div>
                <input
                  type="range"
                  min={50}
                  max={95}
                  step={1}
                  value={targetPrimaryPct}
                  onChange={(e) => setTargetPrimaryPct(Number(e.target.value))}
                  className="custom-slider"
                  aria-label="Target allocation split"
                />
              </div>

              <div className="preset-chips">
                {[
                  { label: '85% / 15% (Recommended)', v: 85 },
                  { label: '80% / 20% (Growth)', v: 80 },
                  { label: '90% / 10% (Conservative)', v: 90 },
                  { label: '70% / 30% (Balanced)', v: 70 },
                ].map((p) => (
                  <button
                    key={p.v}
                    type="button"
                    className={`preset-btn${targetPrimaryPct === p.v ? ' on' : ''}`}
                    onClick={() => setTargetPrimaryPct(p.v)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid-2" style={{ alignContent: 'start' }}>
              <div className="subpanel" style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--line))', background: 'var(--accent-soft)' }}>
                <div className="row">
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>
                    Add to {rebalancerPlan.primary.account.platformName}
                  </span>
                  <span className="chip sm">{newCapitalBase > 0 ? `${((rebalancerPlan.addPrimary / newCapitalBase) * 100).toFixed(1)}%` : '0%'}</span>
                </div>
                <div className="font-display" style={{ fontSize: 24, fontWeight: 800, marginTop: 8, color: 'var(--accent)' }}>
                  {fmtDisplay(rebalancerPlan.addPrimary)}
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  New Value: {fmtDisplay(rebalancerPlan.postPrimary)} ({rebalancerPlan.postPrimaryPct.toFixed(1)}%)
                </div>
              </div>

              <div className="subpanel" style={{ borderColor: 'rgba(245, 158, 11, 0.35)', background: 'var(--warn-soft)' }}>
                <div className="row">
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--warn)' }}>
                    Add to {rebalancerPlan.secondary.account.platformName}
                  </span>
                  <span className="chip sm">{newCapitalBase > 0 ? `${((rebalancerPlan.addSecondary / newCapitalBase) * 100).toFixed(1)}%` : '0%'}</span>
                </div>
                <div className="font-display" style={{ fontSize: 24, fontWeight: 800, marginTop: 8, color: 'var(--warn)' }}>
                  {fmtDisplay(rebalancerPlan.addSecondary)}
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  New Value: {fmtDisplay(rebalancerPlan.postSecondary)} ({rebalancerPlan.postSecondaryPct.toFixed(1)}%)
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ==================== MAIN 2-COL GRID: ALLOCATION + INSPECTOR ==================== */}
      <div className="grid-12">
        <section className="card" style={{ margin: 0 }}>
          <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0 }}>Asset Allocation</h2>
              <div className="small muted">
                {activePie === 'account' ? 'By Account Bucket' : activePie === 'class' ? 'By Asset Class' : 'By Individual Holding'}
              </div>
            </div>
            <div className="seg" role="tablist" aria-label="Allocation view">
              <button type="button" aria-pressed={activePie === 'account'} onClick={() => { setActivePie('account'); setSelectedSlice(null); }}>By Account</button>
              <button type="button" aria-pressed={activePie === 'class'} onClick={() => { setActivePie('class'); setSelectedSlice(null); }}>By Class</button>
              <button type="button" aria-pressed={activePie === 'holding'} onClick={() => { setActivePie('holding'); setSelectedSlice(null); }}>By Holding</button>
            </div>
          </div>

          <AllocationPie
            slices={pieSlices}
            total={totalPieValue}
            base={base}
            mode={chartMode}
            selectedKey={selectedSlice}
            onSelect={setSelectedSlice}
            formatValue={fmtDisplay}
            title={activePie === 'account' ? 'buckets' : activePie === 'class' ? 'classes' : 'holdings'}
          />
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Selected Asset / Overall Detail Inspector */}
          <section className="card" style={{ margin: 0 }}>
            <div className="row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <span className="kpi-tag">{inspector.tag}</span>
                <h2 style={{ margin: '8px 0 2px', fontSize: 20, fontWeight: 800 }}>{inspector.title}</h2>
                <div className="small muted">{inspector.subtitle}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="small muted">Value Share</div>
                <div className="font-display" style={{ fontSize: 24, fontWeight: 800 }}>
                  {inspector.sharePct.toFixed(2)}%
                </div>
              </div>
            </div>

            <dl className="detail-dl">
              <div className="detail-dl-row">
                <dt>Current Value</dt>
                <dd>{fmtDisplay(inspector.valueBase)}</dd>
              </div>
              <div className="detail-dl-row">
                <dt>Net Deposits (Cost Basis)</dt>
                <dd>{inspector.depositBase > 0 ? fmtDisplay(inspector.depositBase) : '—'}</dd>
              </div>
              <div className="detail-dl-row">
                <dt>Net Profit / Loss</dt>
                <dd style={{ color: inspector.pnlBase == null ? 'var(--muted)' : inspector.pnlBase >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                  {inspector.pnlBase != null
                    ? `${inspector.pnlBase >= 0 ? '+' : '−'}${fmtDisplay(Math.abs(inspector.pnlBase))}${inspector.retPct != null ? ` (${inspector.retPct >= 0 ? '+' : '−'}${Math.abs(inspector.retPct).toFixed(2)}%)` : ''}`
                    : '—'}
                </dd>
              </div>
              <div className="detail-dl-row" style={{ paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 12 }}>
                <dt>Other Currencies</dt>
                <dd style={{ fontWeight: 600, color: 'var(--text-2)' }}>{otherCurrenciesLine(inspector.valueBase)}</dd>
              </div>
            </dl>
          </section>

          {/* Compact Strategy & Target Selector */}
          <section className="card" style={{ margin: 0 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Target Strategy</h2>
              <div style={{ minWidth: 180 }}>
                <ThemedSelect
                  value={vault.prefs.coachStrategy ?? '60-40'}
                  onChange={(v: string) => store.setPrefs({ coachStrategy: v })}
                  options={Object.values(FAMED_STRATEGIES).map((s) => ({ value: s.key, label: s.name }))}
                  aria-label="Portfolio strategy"
                />
              </div>
            </div>
            {(() => {
              const key = vault.prefs.coachStrategy ?? '60-40';
              const strat = FAMED_STRATEGIES[key as keyof typeof FAMED_STRATEGIES];
              if (!strat) return null;
              if (key === 'custom') {
                const custom = vault.prefs.targetAllocation ?? {};
                return (
                  <div className="cols">
                    {ASSET_CLASSES.map((cls) => {
                      const cur = Math.round(((custom[cls] ?? 0) as number) * 100);
                      return (
                        <label key={cls} className="field" style={{ margin: 0 }}>
                          <span>{cls} %</span>
                          <input
                            type="number"
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
                          />
                        </label>
                      );
                    })}
                  </div>
                );
              }
              return (
                <>
                  <p className="small muted" style={{ margin: '0 0 8px' }}>{strat.blurb}</p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {Object.entries(strat.allocation).map(([cls, w]) => (
                      <span key={cls} className="chip sm ok">{cls} {Math.round(w * 100)}%</span>
                    ))}
                  </div>
                </>
              );
            })()}
          </section>
        </div>
      </div>

      {/* ==================== COMPLETE PORTFOLIO BREAKDOWN TABLE ==================== */}
      {accountRows.length > 0 && (
        <section className="pf-table-card" aria-label="Complete Portfolio Breakdown">
          <div className="pf-table-head">
            <div>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Complete Portfolio Breakdown</h2>
              <div className="small muted">
                {deployEnabled && rebalancerPlan ? 'Projected post-deployment snapshot' : 'Current live valuation across Investments & Emergency Buffer'}
              </div>
            </div>
            <span className="kpi-tag">Currency: {displayCur} ({currencyInfo(displayCur).symbol})</span>
          </div>

          <div className="pf-table-wrap">
            <table className="pf-table">
              <thead>
                <tr>
                  <th>Asset / Bucket</th>
                  <th className="num">Net Deposits</th>
                  <th className="num">Current Value</th>
                  <th className="num">Profit / Loss</th>
                  <th className="num">Return %</th>
                  <th className="num">Allocation %</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'Subtotal: Investments', rows: investRows },
                  { label: 'Subtotal: Emergency Buffer', rows: emergencyRows },
                ].map((group) => {
                  if (group.rows.length === 0) return null;
                  const subDep = group.rows.reduce((s, r) => s + r.depositBase + deployDeltaFor(r.account.id), 0);
                  const subVal = group.rows.reduce((s, r) => s + r.valueBase + deployDeltaFor(r.account.id), 0);
                  const subPnl = subDep > 0 ? subVal - subDep : null;
                  const subRet = subDep > 0 && subPnl != null ? (subPnl / subDep) * 100 : null;
                  const subAlloc = totalCurrentBase > 0 ? (subVal / totalCurrentBase) * 100 : 0;
                  return (
                    <>
                      {group.rows.map((r) => {
                        const dAdd = deployDeltaFor(r.account.id);
                        const val = r.valueBase + dAdd;
                        const dep = r.depositBase + dAdd;
                        const profit = dep > 0 ? val - dep : null;
                        const ret = dep > 0 && profit != null ? (profit / dep) * 100 : null;
                        const alloc = totalCurrentBase > 0 ? (val / totalCurrentBase) * 100 : 0;
                        return (
                          <tr
                            key={r.account.id}
                            onClick={() => { setActivePie('account'); setSelectedSlice(r.account.id); }}
                            style={{ cursor: 'pointer' }}
                          >
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span className="legend-dot" style={{ background: r.color }} />
                                <div>
                                  <div style={{ fontWeight: 650 }}>{r.account.platformName}</div>
                                  <div className="small muted">{r.account.accountType}</div>
                                </div>
                              </div>
                            </td>
                            <td className="num muted">{dep > 0 ? fmtDisplay(dep) : '—'}</td>
                            <td className="num" style={{ fontWeight: 700 }}>{fmtDisplay(val)}</td>
                            <td className="num" style={{ color: profit == null ? 'var(--muted)' : profit >= 0 ? 'var(--good)' : 'var(--bad)', fontWeight: 650 }}>
                              {profit != null ? `${profit >= 0 ? '+' : '−'}${fmtDisplay(Math.abs(profit))}` : '—'}
                            </td>
                            <td className="num" style={{ color: ret == null ? 'var(--muted)' : ret >= 0 ? 'var(--good)' : 'var(--bad)', fontWeight: 650 }}>
                              {ret != null ? `${ret >= 0 ? '+' : '−'}${Math.abs(ret).toFixed(2)}%` : '—'}
                            </td>
                            <td className="num" style={{ fontWeight: 700 }}>{alloc.toFixed(2)}%</td>
                          </tr>
                        );
                      })}
                      <tr key={group.label} className="sub-row">
                        <td style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>{group.label}</td>
                        <td className="num">{subDep > 0 ? fmtDisplay(subDep) : '—'}</td>
                        <td className="num">{fmtDisplay(subVal)}</td>
                        <td className="num" style={{ color: subPnl == null ? 'var(--muted)' : subPnl >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                          {subPnl != null ? `${subPnl >= 0 ? '+' : '−'}${fmtDisplay(Math.abs(subPnl))}` : '—'}
                        </td>
                        <td className="num" style={{ color: subRet == null ? 'var(--muted)' : subRet >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                          {subRet != null ? `${subRet >= 0 ? '+' : '−'}${Math.abs(subRet).toFixed(2)}%` : '—'}
                        </td>
                        <td className="num" style={{ color: 'var(--accent)' }}>{subAlloc.toFixed(2)}%</td>
                      </tr>
                    </>
                  );
                })}
                <tr className="grand-row">
                  <td style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.6px' }}>Grand Total ({accountRows.length} Buckets)</td>
                  <td className="num">{totalDepositBase > 0 ? fmtDisplay(totalDepositBase) : '—'}</td>
                  <td className="num">{fmtDisplay(totalCurrentBase)}</td>
                  <td className="num" style={{ color: totalPnlBase == null ? 'var(--muted)' : totalPnlBase >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                    {totalPnlBase != null ? `${totalPnlBase >= 0 ? '+' : '−'}${fmtDisplay(Math.abs(totalPnlBase))}` : '—'}
                  </td>
                  <td className="num" style={{ color: totalPnlPct == null ? 'var(--muted)' : totalPnlPct >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                    {totalPnlPct != null ? `${totalPnlPct >= 0 ? '+' : '−'}${Math.abs(totalPnlPct).toFixed(2)}%` : '—'}
                  </td>
                  <td className="num">{totalCurrentBase > 0 ? '100.00%' : '0.00%'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ==================== MANAGE PORTFOLIO (CLEAN TABBED WORKSPACE) ==================== */}
      <div ref={manageRef}>
        <div className="row" style={{ margin: '24px 0 12px', flexWrap: 'wrap' }}>
          <h2 className="section-title" style={{ margin: 0 }}>Manage Portfolio</h2>
          <div className="subtabs" role="tablist" aria-label="Manage portfolio tabs">
            <button type="button" className={manageTab === 'accounts' ? 'on' : ''} onClick={() => setManageTab('accounts')}>
              Accounts &amp; Holdings ({vault.accounts.length})
            </button>
            <button type="button" className={manageTab === 'add' ? 'on' : ''} onClick={() => setManageTab('add')}>
              + Add Account / Holding
            </button>
            <button type="button" className={manageTab === 'tools' ? 'on' : ''} onClick={() => setManageTab('tools')}>
              Reserve, Goals &amp; Auto-Invest
            </button>
          </div>
        </div>

        {manageTab === 'add' && (
          <div className="grid-2">
            <Disclosure id="accounts" title="1. New Account" defaultOpen>
              <div className="card" style={{ margin: 0 }}>
                <h2 className="disclosure-desktop-title">1. New Account</h2>
                <p className="small muted" style={{ margin: '0 0 10px' }}>
                  {isRobo
                    ? 'All-in-one setup: creates the account AND its target allocation sleeves together.'
                    : 'Creates the account first — then add individual stocks, crypto, or cash holdings in Step 2.'}
                </p>
                <div className="row small" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {[
                    { name: 'StashAway', type: 'robo' as const },
                    { name: 'Hata', type: 'crypto' as const },
                    { name: 'Luno', type: 'crypto' as const },
                    { name: 'IBKR', type: 'broker' as const },
                    { name: 'Moomoo', type: 'broker' as const },
                    { name: 'Cash', type: 'cash' as const },
                  ].map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className={`chip sm${platform.toLowerCase() === p.name.toLowerCase() && acctType === p.type ? ' on' : ''}`}
                      onClick={() => { setPlatform(p.name); setAcctType(p.type); }}
                    >
                      + {p.name}
                    </button>
                  ))}
                </div>
                <div className="cols">
                  <label className="field"><span>Where is it?</span>
                    <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="StashAway, Luno, IBKR…" />
                  </label>
                  <label className="field"><span>Type</span>
                    <ThemedSelect
                      value={acctType}
                      onChange={(v: string) => setAcctType(v as typeof acctType)}
                      options={[
                        { value: 'robo', label: 'Robo-advisor (StashAway)' },
                        { value: 'broker', label: 'Broker' },
                        { value: 'crypto', label: 'Crypto wallet' },
                        { value: 'cash', label: 'Cash / MMF' },
                        { value: 'other', label: 'Other' },
                      ]}
                      aria-label="Account type"
                    />
                  </label>
                  {isRobo && (
                    <>
                      <label className="field"><span>Put in ({base})</span>
                        <input type="number" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="e.g. 15000" />
                      </label>
                      <label className="field"><span>Current value ({base}) (optional)</span>
                        <input type="number" inputMode="decimal" value={roboCurrentStart} onChange={(e) => setRoboCurrentStart(e.target.value)} placeholder="Match StashAway today" />
                      </label>
                    </>
                  )}
                </div>
                {isRobo && (
                  <div className="field" style={{ marginTop: 10 }}>
                    <span>Assets &amp; allocation %</span>
                    {roboRows.map((r, i) => {
                      const cacheKey = (r.ticker && r.ticker.trim()) ? r.ticker.trim().toUpperCase() : r.assetClass;
                      const liveRef = saRefs[cacheKey];
                      return (
                        <div key={i} style={{ marginBottom: 10, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--line)' }}>
                          <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                              <ThemedSelect
                                value={r.assetClass}
                                onChange={(v: string) => {
                                  setRoboRows((prev) => prev.map((row, j) => (j === i ? { ...row, assetClass: v as typeof r.assetClass } : row)));
                                  void seedRoboRefs([{ assetClass: v, ticker: r.ticker }]);
                                }}
                                options={[
                                  { value: 'equity-us', label: 'Global equities' },
                                  { value: 'equity-local', label: 'Local equities' },
                                  { value: 'etf', label: 'ETF / index fund' },
                                  { value: 'gold', label: 'Gold' },
                                  { value: 'crypto', label: 'Crypto' },
                                  { value: 'cash', label: 'Cash / MMF' },
                                  { value: 'mmf', label: 'Money market' },
                                ]}
                                aria-label="Asset class"
                              />
                            </div>
                            <input
                              type="number"
                              value={r.pct}
                              onChange={(e) => setRoboRows((prev) => prev.map((row, j) => (j === i ? { ...row, pct: e.target.value } : row)))}
                              style={{ width: 68, textAlign: 'right' }}
                              aria-label="Allocation percent"
                              placeholder="%"
                            />
                            <button
                              type="button"
                              className="btn ghost sm"
                              aria-label="Remove sleeve"
                              onClick={() => setRoboRows((prev) => prev.filter((_, j) => j !== i))}
                              disabled={roboRows.length <= 1}
                            >✕</button>
                          </div>
                          {/* Ticker row — optional. When set, live quotes track this exact instrument */}
                          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <input
                                value={r.ticker}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setRoboRows((prev) => prev.map((row, j) => (j === i ? { ...row, ticker: val } : row)));
                                }}
                                onBlur={() => {
                                  if (r.ticker.trim()) void seedRoboRefs([{ assetClass: r.assetClass, ticker: r.ticker }]);
                                }}
                                placeholder="Ticker (optional) — e.g. CSPX, GLD, QQQ"
                                style={{ width: '100%', fontSize: 12 }}
                                aria-label="Ticker symbol"
                              />
                            </div>
                            {liveRef && liveRef > 0 && (
                              <span className="chip sm ok" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                                ref {liveRef.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              </span>
                            )}
                          </div>
                          {r.ticker.trim() && (
                            <div className="small muted" style={{ marginTop: 4, fontSize: 11 }}>
                              P&L will auto-calculate using live <strong>{r.ticker.trim().toUpperCase()}</strong> price
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button type="button" className="btn ghost sm" onClick={() => setRoboRows((prev) => [...prev, { assetClass: 'equity-us', pct: '0', ticker: '' }])}>
                      <IPlus size={14} /> Add sleeve
                    </button>
                  </div>
                )}
                <button className="btn sm" style={{ width: '100%', marginTop: 12 }} onClick={() => void addAccount()}>
                  <IPlus size={15} /> {isRobo ? 'Create portfolio & sleeves' : 'Create account'}
                </button>
              </div>
            </Disclosure>

            <Disclosure id="add-holding" title="2. Add Holding to Account" defaultOpen>
              <div className="card" style={{ margin: 0 }}>
                <h2 className="disclosure-desktop-title">2. Add Holding to Account</h2>
                {vault.accounts.length === 0 ? (
                  <div className="empty">
                    Create an account in Step 1 first — then add individual stocks, ETFs, crypto, or cash holdings here.
                  </div>
                ) : (
                  <>
                    <label className="field"><span>Target Account</span>
                      <ThemedSelect
                        value={accountId}
                        onChange={(v: string) => setAccountId(v)}
                        options={vault.accounts.map((a) => ({
                          value: a.id,
                          label: `${a.platformName}${a.accountType === 'robo' ? ' (Robo)' : ''}`,
                        }))}
                        placeholder="Select an account…"
                        aria-label="Target account"
                      />
                    </label>
                    {targetIsRobo ? (
                      <>
                        <p className="small muted" style={{ margin: '0 0 10px' }}>
                          <strong>{targetAcct?.platformName}</strong> already tracks the allocation sleeves set in Step 1. Add another % sleeve below only if you want to expand its mix.
                        </p>
                        <div className="cols">
                          <label className="field"><span>Asset class</span>
                            <ThemedSelect
                              value={assetClass}
                              onChange={(v: string) => pickAssetClass(v as typeof assetClass)}
                              options={[
                                { value: 'equity-us', label: 'Global equities' },
                                { value: 'equity-local', label: 'Local equities' },
                                { value: 'etf', label: 'ETF / index fund' },
                                { value: 'gold', label: 'Gold' },
                                { value: 'crypto', label: 'Crypto' },
                                { value: 'cash', label: 'Cash / MMF' },
                                { value: 'mmf', label: 'Money market' },
                              ]}
                              aria-label="What is it?"
                            />
                          </label>
                          <label className="field"><span>Allocation %</span>
                            <input type="number" inputMode="decimal" value={roboSleevePct} onChange={(e) => setRoboSleevePct(e.target.value)} placeholder="e.g. 15" />
                          </label>
                          <label className="field"><span>Ticker (optional)</span>
                            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="CSPX, GLD, QQQ" />
                          </label>
                        </div>
                        <button className="btn sm" style={{ width: '100%', marginTop: 12 }} disabled={!accountId} onClick={() => void addRoboSleeve()}>
                          <IPlus size={15} /> Add sleeve to {targetAcct?.platformName}
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="small muted" style={{ margin: '0 0 10px' }}>
                          Add an individual stock, ETF, crypto coin, or cash balance to <strong>{targetAcct?.platformName ?? 'your account'}</strong>.
                        </p>
                        <div className="cols">
                          <label className="field"><span>Symbol</span>
                            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={parMode} placeholder={parMode ? 'auto (par)' : 'AAPL / BTC / 1155.KL'} />
                          </label>
                          <label className="field"><span>Asset class</span>
                            <ThemedSelect value={assetClass} onChange={(v: string) => pickAssetClass(v as typeof assetClass)} options={ASSET_CLASSES.map((c) => ({ value: c, label: c }))} aria-label="What is it?" />
                          </label>
                          {parMode ? (
                            <label className="field"><span>Amount ({holdCur})</span>
                              <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="4000" />
                            </label>
                          ) : (
                            <>
                              <label className="field"><span>Units</span>
                                <input type="number" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="10" />
                              </label>
                              <label className="field"><span>Avg buy price</span>
                                <input type="number" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="12.40" />
                              </label>
                            </>
                          )}
                          <label className="field"><span>Currency</span>
                            <ThemedSelect value={holdCur} onChange={(v: string) => setHoldCur(v)} options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))} aria-label="Currency" />
                          </label>
                        </div>
                        <button className="btn sm" style={{ width: '100%', marginTop: 12 }} disabled={!accountId} onClick={() => void addHolding()}>
                          <IPlus size={15} /> Add holding to {targetAcct?.platformName ?? 'account'}
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </Disclosure>
          </div>
        )}

        {manageTab === 'accounts' && (
          <div className="grid-2">
            <div className="card" style={{ margin: 0 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>Your Accounts ({vault.accounts.length})</h2>
                <button className="btn ghost sm" onClick={() => setManageTab('add')}>+ New Account</button>
              </div>
              {vault.accounts.length === 0 ? (
                <div className="empty">No accounts yet — switch to "+ Add Account / Holding" to create one.</div>
              ) : (
                <div>
                  {(Object.keys(SECTION_META) as PortfolioSection[]).map((section) => {
                    const sectionAccounts = vault.accounts.filter((a) => sectionForType(a.accountType) === section);
                    if (sectionAccounts.length === 0) return null;
                    const meta = SECTION_META[section];
                    return (
                      <div key={section} className="pf-section">
                        <div className="pf-section-head">
                          <div>
                            <div className="pf-section-title">{meta.title}</div>
                            <div className="pf-section-sub">{meta.subtitle}</div>
                          </div>
                        </div>
                        {sectionAccounts.map((a) => {
                          const holdings = vault.holdings.filter((h) => h.accountId === a.id).length;
                          const isTarget = a.id === accountId;
                          const line = accLines.get(a.id);
                          const hasDeposit = typeof a.initialDepositBase === 'number' && a.initialDepositBase > 0;
                          const reserved = reservedIds.has(a.id);
                          const effCost = line ? (line.depositBase ?? (line.costBase > 0 ? line.costBase : null)) : null;
                          const effPnl = line && effCost != null && line.valueBase > 0 ? (line.pnlBase ?? line.valueBase - effCost) : null;
                          const effRet = effPnl != null && effCost && effCost > 0 ? (effPnl / effCost) * 100 : null;
                          const pnlGood = effPnl != null && effPnl >= 0;
                          const pnlBad = effPnl != null && effPnl < 0;
                          return (
                            <div className="acc-card" key={a.id}>
                              <div className="acc-head">
                                <div className="acc-name grow">
                                  {a.platformName}
                                  {isTarget && (
                                    <button className="chip sm on" aria-pressed onClick={() => setAccountId(a.id)} title="Holding form target">
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
                                    { label: reserved ? 'Remove from reserve' : 'Add to reserve', icon: ICheck, onClick: () => (reserved ? unReserve(a.id) : toReserve(a.id)) },
                                    { label: 'Add holding to this account', icon: ICheck, hide: isTarget, onClick: () => { setAccountId(a.id); setManageTab('add'); } },
                                    { label: 'Edit amount put in', icon: IPlus, onClick: () => openDeposit(a.id) },
                                    {
                                      label: a.accountType === 'robo' ? "Match StashAway's value" : 'Use broker value',
                                      icon: IPlus,
                                      hide: a.accountType === 'robo' ? (Number.isFinite(a.brokerValueBase) && (a.brokerValueBase ?? 0) > 0) : undefined,
                                      onClick: () => openCostBasis(),
                                    },
                                    { label: 'Delete account', danger: true, onClick: () => removeAccount(a.id) },
                                  ]}
                                />
                              </div>
                              <div className="acc-value">
                                {line && line.valueBase > 0 ? (
                                  <span className="val">
                                    {formatMoney(line.valueBase, base)}
                                    {Number.isFinite(a.brokerValueBase) && (a.brokerValueBase ?? 0) > 0 && (
                                      <>
                                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--warn)' }}>broker</span>
                                        <button
                                          type="button"
                                          className="chip sm"
                                          aria-label={`Clear broker value for ${a.platformName}`}
                                          onClick={() => {
                                            store.updateAccount(a.id, { brokerValueBase: undefined });
                                            toast(`${a.platformName}: broker value cleared.`, 'ok');
                                          }}
                                          style={{ marginLeft: 4, cursor: 'pointer' }}
                                        >
                                          ✕
                                        </button>
                                      </>
                                    )}
                                  </span>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                                {effPnl != null && effRet != null && (
                                  <span className={`ret ${pnlGood ? 'pos' : pnlBad ? 'neg' : ''}`}>
                                    {effPnl >= 0 ? '+' : ''}{formatMoney(effPnl, base)} ({effRet >= 0 ? '+' : ''}{effRet.toFixed(1)}%)
                                  </span>
                                )}
                              </div>
                              <div className="acc-daily">
                                <DailyChangePill delta={dailyChange.get(a.id) ?? null} base={base} />
                              </div>
                              <div className="acc-foot">
                                <span className="muted small">
                                  {a.accountType === 'robo' ? 'Robo-advisor' : a.accountType}
                                  {holdings > 0 ? ` · ${holdings} ${holdings === 1 ? 'asset' : 'assets'}` : ' · 0 assets'}
                                </span>
                                <button
                                  className={`dep-edit${hasDeposit || (line?.costBase ?? 0) > 0 ? '' : ' empty'}`}
                                  onClick={() => openDeposit(a.id)}
                                >
                                  {hasDeposit ? (
                                    <>
                                      <span className="val">Put in {formatMoney(a.initialDepositBase!, base)}</span>
                                      <IPencil size={13} />
                                    </>
                                  ) : (line?.costBase ?? 0) > 0 ? (
                                    <>
                                      <span className="val">Cost basis {formatMoney(line!.costBase, base)}</span>
                                      <IPencil size={13} />
                                    </>
                                  ) : (
                                    <>
                                      How much have you put in?
                                      <IPlus size={13} />
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card" style={{ margin: 0 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>Holdings ({vault.holdings.length})</h2>
                <button className="btn ghost sm" onClick={() => setManageTab('add')}>+ Add Holding</button>
              </div>
              {vault.holdings.length === 0 ? (
                <div className="empty">No holdings yet — add one under "+ Add Account / Holding".</div>
              ) : (
                [...grouped.entries()].map(([plat, holds]) => (
                  <div key={plat} style={{ marginTop: 12 }}>
                    <div className="small muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                      {plat}
                    </div>
                    <div className="list" style={{ marginTop: 0 }}>
                      {holds.map((h) => {
                        const q = live.quotes[h.symbol];
                        const par = isParClass(h.assetClass);
                        if (h.isAllocation) {
                          const acct = vault.accounts.find((a) => a.id === h.accountId);
                          const accLine = accLines.get(h.accountId);
                          const sleeveLine = accLine?.lines.find((l) => l.holding.id === h.id);
                          const val = sleeveLine?.valueBase ?? 0;
                          const sliceCost = ((h.allocationPct ?? 0) / 100) * (acct?.initialDepositBase ?? 0);
                          const hasSlicePnl = !par && sliceCost > 0 && val > 0;
                          const profit = hasSlicePnl ? val - sliceCost : 0;
                          const ret = hasSlicePnl ? (profit / sliceCost) * 100 : 0;
                          const ok = sleeveLine ? sleeveLine.ok : val > 0;
                          return (
                            <div className="item" key={h.id}>
                              <div className="grow">
                                <div className="title">
                                  {h.symbol}{' '}
                                  <span className="muted small">
                                    · {(h.allocationPct ?? 0).toFixed(1)}%
                                    {!par && q && q.price > 0 ? ` · ${q.currency} ${q.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
                                  </span>
                                </div>
                                <div className="meta">
                                  {hasSlicePnl && (
                                    <span className={profit >= 0 ? 'pos' : 'neg'}>
                                      {profit >= 0 ? '+' : ''}{formatMoney(profit, base)} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)
                                    </span>
                                  )}
                                  {!ok && ' · awaiting price'}
                                </div>
                              </div>
                              <div className="amt">{ok ? formatMoney(val, base) : '—'}</div>
                              <button className="edit" aria-label={`Edit ${h.symbol}`} onClick={() => openEdit(h)}>
                                <IPencil size={15} />
                              </button>
                              <DelButton
                                label={`Delete ${h.symbol}`}
                                onConfirm={() => {
                                  store.deleteHolding(h.id);
                                  if (editHolding?.id === h.id) closeEdit();
                                  toast(`Deleted ${h.symbol}`);
                                }}
                              />
                            </div>
                          );
                        }
                        const { valueBase: val, costBase: cost, ok } = valueInBase(h, q, base, rateToBase);
                        const ret = ok && cost > 0 ? ((val - cost) / cost) * 100 : 0;
                        const profit = ok && cost > 0 ? val - cost : 0;
                        const showVal = ok ? formatMoney(val, base) : '—';
                        return (
                          <div className="item" key={h.id}>
                            <div className="grow">
                              <div className="title">{h.symbol} <span className="muted small">× {Number.isFinite(h.units) ? h.units : '—'}</span></div>
                              <div className="meta">
                                {!par && cost > 0 && (
                                  <span className={profit >= 0 ? 'pos' : 'neg'}>
                                    {profit >= 0 ? '+' : ''}{formatMoney(profit, base)} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)
                                  </span>
                                )}
                                {!ok && ' · awaiting price'}
                              </div>
                            </div>
                            <div className="amt">{showVal}</div>
                            <button className="edit" aria-label={`Edit ${h.symbol}`} onClick={() => openEdit(h)}>
                              <IPencil size={15} />
                            </button>
                            <DelButton
                              label={`Delete ${h.symbol}`}
                              onConfirm={() => {
                                store.deleteHolding(h.id);
                                if (editHolding?.id === h.id) closeEdit();
                                toast(`Deleted ${h.symbol}`);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {manageTab === 'tools' && (
          <div className="grid-2">
            <div>
              <h3 className="section-title" style={{ marginTop: 0 }}>Emergency Reserve</h3>
              <EmergencyPanel />
              <h3 className="section-title">Savings Goals</h3>
              <SavingsGoalsPanel />
            </div>
            <div>
              <h3 className="section-title" style={{ marginTop: 0 }}>Money In (Contributions)</h3>
              <ContributionPanel fx={live.fx} />
              {vault.autoInvests && vault.autoInvests.length > 0 && (
                <>
                  <h3 className="section-title">Auto-Invest</h3>
                  <AutoInvestPanel fx={live.fx} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ==================== MODALS ==================== */}
      {editHolding && (
        <Modal title={`Edit ${editHolding.symbol} ${mIsAlloc ? 'sleeve' : 'holding'}`} onClose={closeEdit}>
          <div className="cols">
            <label className="field"><span>{mIsAlloc ? 'Ticker (optional)' : 'Symbol'}</span>
              <input value={mSymbol} onChange={(e) => setMSymbol(e.target.value)} disabled={(!mIsAlloc && mPar) || mIsRobo} placeholder={mIsAlloc ? 'CSPX, GLD, QQQ' : undefined} />
            </label>
            <label className="field"><span>Asset class</span>
              <ThemedSelect
                value={mClass}
                onChange={(v: string) => {
                  const c = v as InvestmentHolding['assetClass'];
                  setMClass(c);
                  if (!mIsAlloc && isParClass(c)) setMSymbol(parSymbolFor(c));
                }}
                options={ASSET_CLASSES.map((c) => ({ value: c, label: c }))}
                aria-label="What is it?"
              />
            </label>
            {mIsAlloc ? (
              <label className="field"><span>Allocation %</span>
                <input type="number" inputMode="decimal" value={mAllocPct} onChange={(e) => setMAllocPct(e.target.value)} />
              </label>
            ) : mIsRobo ? (
              <label className="field"><span>Worth ({mCur})</span>
                <input type="number" inputMode="decimal" value={mValue} onChange={(e) => setMValue(e.target.value)} />
              </label>
            ) : mPar ? (
              <label className="field"><span>Amount ({mCur})</span>
                <input type="number" inputMode="decimal" value={mAmount} onChange={(e) => setMAmount(e.target.value)} />
              </label>
            ) : (
              <>
                <label className="field"><span>Units</span>
                  <input type="number" inputMode="decimal" value={mUnits} onChange={(e) => setMUnits(e.target.value)} />
                </label>
                <label className="field"><span>Buy price</span>
                  <input type="number" inputMode="decimal" value={mEntry} onChange={(e) => setMEntry(e.target.value)} />
                </label>
              </>
            )}
            {!mIsAlloc && (
              <label className="field"><span>Currency</span>
                <ThemedSelect value={mCur} onChange={(v: string) => setMCur(v)} options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))} aria-label="Currency" />
              </label>
            )}
          </div>
          <div className="row" style={{ marginTop: 14, gap: 10 }}>
            <button className="btn ghost sm" style={{ flex: 1 }} onClick={closeEdit}>Cancel</button>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => void saveHoldingEdit()}>Save changes</button>
          </div>
        </Modal>
      )}

      {depOpen && (
        <Modal title="How much have you put in?" onClose={() => setDepOpen(false)}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Enter the total net deposits per account. Profit/loss is measured against this baseline.
          </p>
          <div className="list" style={{ marginTop: 8 }}>
            {vault.accounts.map((a) => (
              <div className="item" key={a.id} data-dep-focus={a.id === depFocusId ? '1' : undefined}>
                <div className="grow">
                  <div className="title">{a.platformName}</div>
                  <div className="meta muted small">{a.accountType}</div>
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  className={`dep-input${a.id === depFocusId ? ' focus' : ''}`}
                  value={typeof a.initialDepositBase === 'number' ? String(a.initialDepositBase) : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    store.updateAccount(a.id, { initialDepositBase: v.trim() === '' ? undefined : parseFloat(v) });
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

      {costOpen && (
        <Modal title="Match your broker's amounts" onClose={() => setCostOpen(false)}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Enter your net deposits and StashAway&apos;s current value once. For robo/StashAway accounts, OmniFlow calibrates each sleeve so today matches 1:1 and tomorrow tracks live ticker &amp; FX moves automatically.
          </p>
          <div className="list" style={{ marginTop: 8 }}>
            {vault.accounts.map((a) => {
              const line = live.portfolio?.byAccount.find((l) => l.account.id === a.id);
              const liveValue = line?.valueBase ?? 0;
              return (
                <div key={a.id} className="subpanel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontWeight: 700 }}>{a.platformName} <span className="small muted">· live {formatMoney(liveValue, base)}</span></div>
                  <div className="grid-2">
                    <label className="field" style={{ margin: 0 }}>
                      <span>Total invested ({base})</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={costDrafts[a.id] ?? ''}
                        onChange={(e) => setCostDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                        placeholder="e.g. 6000"
                      />
                    </label>
                    <label className="field" style={{ margin: 0 }}>
                      <span>Current broker value (optional)</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={brokerValueDrafts[a.id] ?? ''}
                        onChange={(e) => setBrokerValueDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                        placeholder="e.g. 46765"
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 14, gap: 8 }}>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => void saveCostBasis()}>Save</button>
            <button className="btn ghost sm" onClick={() => setCostOpen(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

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
      <button className="menu-toggle" aria-label="Account actions" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
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
