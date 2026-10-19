// ============================================================================
// Investments — platform-agnostic portfolio view + holding CRUD.
// Grouped by platformName, with live quotes and FX-converted base values.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { Disclosure } from '../components/Disclosure';
import { EmergencyPanel } from './EmergencyPanel';
import { SavingsGoalsPanel } from './SavingsGoalsPanel';
import { AutoInvestPanel } from './AutoInvestPanel';
import { AllocationBar } from '../components/AllocationBar';
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
import { CURRENCIES, currencyInfo, formatMoney } from '../domain/enums';
import { IRefresh, IPlus, IPencil, IX, IDots, ICheck } from '../icons';
import type { InvestmentAccount, InvestmentHolding } from '../domain/types';

const ASSET_CLASSES = ['equity-us', 'equity-local', 'etf', 'crypto', 'cash', 'mmf'] as const;
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
  /** id of the holding being edited, or null when adding a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const addHoldFormRef = useRef<HTMLHeadingElement>(null);
  /** Bumps on each startEdit so the (possibly collapsed) disclosure
   *  containing the form is forced open and the form is revealed. */
  const [editReveal, setEditReveal] = useState(0);
  const parMode = isParClass(assetClass);

  const startEdit = (h: InvestmentHolding) => {
    setAccountId(h.accountId);
    setSymbol(h.symbol);
    setAssetClass(h.assetClass);
    setHoldCur(h.holdingCurrency);
    if (isParClass(h.assetClass)) {
      // Units ARE the amount at par=1.
      setAmount(String(h.units || ''));
      setUnits('');
      setEntry('');
      setSymbol(parSymbolFor(h.assetClass));
    } else {
      setUnits(String(h.units));
      setEntry(String(h.averageEntryPrice || ''));
      setAmount('');
    }
    setEditingId(h.id);
    setEditReveal((n) => n + 1); // force the add-holding disclosure open
    window.setTimeout(() => {
      addHoldFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
    toast(`Editing ${h.symbol} — update the form, then press "Save changes"`);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setSymbol(''); setUnits(''); setEntry(''); setAmount('');
    setAssetClass('equity-us');
    setEditReveal(0);
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

  const saveDeposit = (id: string, raw: string) => {
    const v = raw.trim() === '' ? undefined : parseFloat(raw);
    if (raw.trim() !== '' && (!Number.isFinite(v!) || (v as number) <= 0)) {
      toast('Deposit must be a positive amount in ' + base + '.', 'err');
      return;
    }
    store.updateAccount(id, { initialDepositBase: v });
    toast(v ? 'Starting capital saved — P&L now measures against it.' : 'Starting capital cleared.');
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
    if (editingId) {
      store.updateHolding(editingId, payload);
      // Clear back to add mode — otherwise the leftover values could
      // accidentally duplicate the holding on the next "Add holding" tap.
      setEditingId(null);
      setSymbol(''); setUnits(''); setEntry(''); setAmount('');
      setAssetClass('equity-us'); setHoldCur(base);
      toast(`Updated ${finalSymbol}`);
      return;
    }
    store.addHolding(payload);
    setSymbol(''); setUnits(''); setEntry(''); setAmount('');
    toast(`Added ${finalSymbol} to target account`);
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
        <div className="kpi" style={{ marginBottom: 4 }}>
          <div className="cell">
            <div className="num">{formatMoney(live.portfolio?.totalValueBase ?? 0, base)}</div>
            <div className="lbl">Value ({base})</div>
          </div>
          <div className="cell">
            <div className="num">
              {pnl && pnl.totalPnlBase != null ? (
                <span className={pnl.totalPnlBase >= 0 ? 'pos' : 'neg'}>
                  {pnl.totalPnlBase >= 0 ? '+' : ''}{formatMoney(pnl.totalPnlBase, base)}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </div>
            <div className="lbl">
              P&L on capital{pnl?.totalReturnPct != null ? ` (${pnl.totalReturnPct >= 0 ? '+' : ''}${pnl.totalReturnPct.toFixed(1)}%)` : ''}
            </div>
          </div>
          <div className="cell">
            <div className="num">{vault.holdings.length}</div>
            <div className="lbl">Holdings</div>
          </div>
        </div>

        {/* P&L is undefined until at least one account has a recorded
            invested capital. Surface that as an actionable prompt so the
            user knows exactly what to do, and show it whenever some but not
            all accounts are covered. */}
        {pnl && pnl.totalCapitalBase === 0 && vault.accounts.length > 0 && (
          <div className="row small" style={{ marginBottom: 8, gap: 8, alignItems: 'center' }}>
            <span className="chip sm">No capital recorded yet</span>
            <span className="muted grow">Set a starting balance per account, or log a contribution — P&L then measures against what you've actually invested.</span>
          </div>
        )}
        {pnl && pnl.missingCapitalCount > 0 && pnl.totalCapitalBase > 0 && (
          <div className="row small muted" style={{ marginBottom: 8 }}>
            P&L covers {pnl.accounts.length - pnl.missingCapitalCount} of {pnl.accounts.length} accounts · {pnl.missingCapitalCount} without a recorded balance
          </div>
        )}

        {/* Allocation by asset class — stacked bar + legend. One chart for
            the whole portfolio, driven by the same byAssetClass aggregate
            the KPI panel uses (NaN-safe, uncounted excluded). */}
        {live.portfolio && live.portfolio.byAssetClass.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div className="small muted" style={{ marginBottom: 6 }}>Allocation by class</div>
            <AllocationBar
              items={live.portfolio.byAssetClass}
              total={live.portfolio.totalValueBase}
              base={base}
            />
          </div>
        ) : null}

        {/* Detail pie: donut with drill-down. Toggle between per-class and
            per-holding slices; tap a class slice to see its holdings. */}
        {pieSlices.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <div className="small muted">Detail breakdown</div>
              <div className="row" style={{ gap: 4 }}>
                <button
                  className={`chip sm${activePie === 'class' ? ' on' : ''}`}
                  aria-pressed={activePie === 'class'}
                  onClick={() => setActivePie('class')}
                >
                  By class
                </button>
                <button
                  className={`chip sm${activePie === 'holding' ? ' on' : ''}`}
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

      <Disclosure id="accounts" title={`Accounts${vault.accounts.length ? ` (${vault.accounts.length})` : ''}`}>
      <div className="card">
        <div className="cols">
          <label className="field"><span>Platform (Luno, IBKR, Moomoo…)</span>
            <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="StashAway" />
          </label>
          <label className="field"><span>Type</span>
            <select value={acctType} onChange={(e) => setAcctType(e.target.value as typeof acctType)}>
              <option value="broker">Broker</option>
              <option value="robo">Robo-advisor</option>
              <option value="crypto">Crypto wallet</option>
              <option value="cash">Cash / MMF</option>
              <option value="other">Other</option>
            </select>
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
                    <DepositEdit
                      initial={hasDeposit ? String(a.initialDepositBase) : ''}
                      display={hasDeposit ? formatMoney(a.initialDepositBase!, base) : 'none'}
                      onDone={(v) => saveDeposit(a.id, v)}
                    />
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

      <h2 className="section-title">Auto-invest &amp; contributions</h2>
      <AutoInvestPanel fx={live.fx} />

      <Disclosure id="add-holding" title={editingId ? 'Edit holding' : 'Add holding'} defaultOpen={editingId != null || accountId !== ''} forceOpen={editReveal}>
      <div className="card" ref={addHoldFormRef}>
        {!accountId && !editingId && (
          <div className="small muted" style={{ marginBottom: 8 }}>
            Set a target account above, then add holdings to it.
          </div>
        )}
        {editingId && (
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="chip sm">Editing existing holding</span>
            <button className="btn ghost sm" onClick={cancelEdit}><IX size={14} /> Cancel</button>
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
            <select value={assetClass} onChange={(e) => pickAssetClass(e.target.value as typeof assetClass)}>
              {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
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
            <select value={holdCur} onChange={(e) => setHoldCur(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </label>
        </div>
        <button className={`btn sm${accountId ? '' : ' ghost'}`} style={{ width: '100%' }} disabled={!accountId} onClick={() => void addHolding()}>
          {accountId ? (editingId ? 'Save changes' : 'Add holding') : 'Set a target account first'}
        </button>
      </div>
      </Disclosure>

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
                      if (editingId === h.id) cancelEdit();
                      toast(`Deleted ${h.symbol} holding`);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {vault.holdings.length === 0 && <div className="empty">No holdings yet. Create an account, then add a holding above.</div>}
    </>
  );
}

/** Compact inline editor for an account's starting-capital (deposit) value.
 *  Renders a small input + save that expands in place; keeps the accounts
 *  list tidy without a separate modal. */
function DepositEdit({
  initial,
  display,
  onDone,
}: {
  initial: string;
  display?: string;
  onDone: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(initial);
  const start = () => {
    setVal(initial);
    setEditing(true);
  };
  const commit = () => {
    onDone(val);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button className="dep-edit" onClick={start} title="Edit starting capital">
        {display ? (
          <>
            <span className="val">{display}</span>
            <IPencil size={13} />
          </>
        ) : (
          <>
            Set starting capital
            <IPlus size={13} />
          </>
        )}
      </button>
    );
  }
  return (
    <div className="row" style={{ gap: 6 }}>
      <input
        type="number"
        inputMode="decimal"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        style={{ width: 100 }}
        aria-label="Starting capital"
      />
      <button className="btn ghost sm" onClick={commit}>Save</button>
    </div>
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
