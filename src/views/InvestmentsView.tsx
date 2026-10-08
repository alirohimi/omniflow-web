// ============================================================================
// Investments — platform-agnostic portfolio view + holding CRUD.
// Grouped by platformName, with live quotes and FX-converted base values.
// ============================================================================

import { useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { fxService } from '../services';
import { CURRENCIES, currencyInfo, formatMoney } from '../domain/enums';
import { IRefresh, IPlus, IPencil, IX } from '../icons';
import type { InvestmentAccount, InvestmentHolding } from '../domain/types';

const ASSET_CLASSES = ['equity-us', 'equity-local', 'etf', 'crypto', 'cash', 'mmf'] as const;

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
  const [accountId, setAccountId] = useState('');
  const [symbol, setSymbol] = useState('');
  const [assetClass, setAssetClass] = useState<InvestmentHolding['assetClass']>('equity-us');
  const [holdCur, setHoldCur] = useState(base);
  const [units, setUnits] = useState('');
  const [entry, setEntry] = useState('');
  /** id of the holding being edited, or null when adding a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const addHoldFormRef = useRef<HTMLHeadingElement>(null);

  const startEdit = (h: InvestmentHolding) => {
    setAccountId(h.accountId);
    setSymbol(h.symbol);
    setAssetClass(h.assetClass);
    setHoldCur(h.holdingCurrency);
    setUnits(String(h.units));
    setEntry(String(h.averageEntryPrice || ''));
    setEditingId(h.id);
    window.setTimeout(() => {
      addHoldFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
    toast(`Editing ${h.symbol} — update the form, then press "Save changes"`);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setSymbol(''); setUnits(''); setEntry(''); setAssetClass('equity-us');
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

  const valueBase = (h: InvestmentHolding): number => {
    const q = live.quotes[h.symbol];
    const priceBase = q ? q.price : h.currentPriceBase;
    return priceBase * h.units;
  };

  const addAccount = () => {
    const name = platform.trim();
    if (!name) return;
    const id = store.addAccount({ platformName: name, accountType: acctType });
    setAccountId(id);
    setPlatform('');
    toast(`Account "${name}" created and set as target`);
  };

  const addHolding = async () => {
    const u = parseFloat(units);
    const e = parseFloat(entry);
    if (!accountId || !symbol.trim() || !isFinite(u) || u <= 0) return;
    // Pull an initial live quote so currentPriceBase is seeded (best-effort).
    let local = e || 0;
    let priceBase = e || 0;
    try {
      const rates = await fxService.latest(base);
      if (holdCur !== base) {
        const r = fxService.toBase(1, holdCur, rates);
        priceBase = local * r;
      }
    } catch { /* offline: keep entry as a rough base price */ }
    if (editingId) {
      store.updateHolding(editingId, {
        accountId,
        symbol: symbol.trim().toUpperCase(),
        assetClass,
        holdingCurrency: holdCur,
        units: u,
        averageEntryPrice: e || 0,
        currentPriceLocal: local || undefined,
        currentPriceBase: priceBase || undefined,
      });
      // Clear back to add mode — otherwise the leftover values could
      // accidentally duplicate the holding on the next "Add holding" tap.
      setEditingId(null);
      setSymbol(''); setUnits(''); setEntry('');
      setAssetClass('equity-us'); setHoldCur(base);
      toast(`Updated ${symbol.trim().toUpperCase()}`);
      return;
    }
    store.addHolding({
      accountId,
      symbol: symbol.trim().toUpperCase(),
      assetClass,
      holdingCurrency: holdCur,
      units: u,
      averageEntryPrice: e || 0,
      currentPriceLocal: local || undefined,
      currentPriceBase: priceBase || undefined,
    });
    setSymbol(''); setUnits(''); setEntry('');
    toast(`Added ${symbol.trim().toUpperCase()} to target account`);
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
        <div className="kpi">
          <div className="cell">
            <div className="num">{formatMoney(live.portfolio?.totalValueBase ?? 0, base)}</div>
            <div className="lbl">Total value ({base})</div>
          </div>
          <div className="cell">
            <div className="num">
              <span className={live.portfolio?.totalReturnPct && live.portfolio.totalReturnPct >= 0 ? 'pos' : 'neg'}>
                {live.portfolio?.totalReturnPct != null ? `${live.portfolio.totalReturnPct >= 0 ? '+' : ''}${live.portfolio.totalReturnPct.toFixed(1)}%` : '—'}
              </span>
            </div>
            <div className="lbl">Return vs cost</div>
          </div>
          <div className="cell">
            <div className="num">{vault.holdings.length}</div>
            <div className="lbl">Holdings</div>
          </div>
        </div>
        {live.error && <div className="small neg" style={{ marginTop: 10 }}>{live.error}</div>}
        <div className="row small muted" style={{ marginTop: 10 }}>
          <span>FX: {live.fxSource ?? '…'} · live {live.portfolio?.liveQuoteCount ?? 0} · cached {live.portfolio?.staleQuoteCount ?? 0}</span>
          <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}><IRefresh size={16} /> Refresh</button>
        </div>
      </div>

      <h2 className="section-title">Accounts</h2>
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
        </div>
        <button className="btn ghost sm" onClick={addAccount}><IPlus size={16} /> Create account</button>

        {vault.accounts.length > 0 && (
          <div className="list">
            {vault.accounts.map((a) => {
              const holdings = vault.holdings.filter((h) => h.accountId === a.id).length;
              const isTarget = a.id === accountId;
              return (
                <div className="item" key={a.id}>
                  <div className="grow">
                    <div className="title">
                      {a.platformName}
                      {isTarget && <span className="chip sm" style={{ marginLeft: 8 }}>target</span>}
                    </div>
                    <div className="meta">{a.accountType} · {holdings} holding{holdings === 1 ? '' : 's'}</div>
                  </div>
                  <button
                    className={`btn ghost sm${isTarget ? ' active' : ''}`}
                    aria-pressed={isTarget}
                    onClick={() => setAccountId(a.id)}
                  >
                    {isTarget ? 'Target set' : 'Set target'}
                  </button>
                  <DelButton label={`Delete ${a.platformName}`} onConfirm={() => removeAccount(a.id)} />
                </div>
              );
            })}
          </div>
        )}
        {vault.accounts.length === 0 && (
          <div className="empty">No accounts yet — create one above.</div>
        )}
      </div>

      <h2 className="section-title" ref={addHoldFormRef}>{editingId ? 'Edit holding' : 'Add holding'}</h2>
      <div className="card">
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
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="AAPL / CSPX.L / BTC / 1155.KL" />
          </label>
          <label className="field"><span>Asset class</span>
            <select value={assetClass} onChange={(e) => setAssetClass(e.target.value as typeof assetClass)}>
              {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field"><span>Units</span>
            <input type="number" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="10" />
          </label>
          <label className="field"><span>Avg entry</span>
            <input type="number" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="12.40" />
          </label>
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

      {[...grouped.entries()].map(([plat, holds]) => (
        <div key={plat}>
          <h2 className="section-title">{plat}</h2>
          <div className="list">
            {holds.map((h) => {
              const q = live.quotes[h.symbol];
              const val = valueBase(h);
              const isLive = q && q.source === 'coingecko' || q?.source === 'yahoo';
              const cost = h.averageEntryPrice * h.units * fxService.toBase(1, h.holdingCurrency, live.fx ?? { base, rates: {}, asOf: 0, source: 'cache' });
              const ret = cost > 0 ? ((val - cost) / cost) * 100 : 0;
              return (
                <div className="item" key={h.id}>
                  <div className="grow">
                    <div className="title">{h.symbol} <span className="muted small">× {h.units} {h.holdingCurrency}</span></div>
                    <div className="meta">
                      {h.assetClass} · {q ? (isLive ? `live ${new Date(q.asOf).toLocaleString()}` : `cached ${new Date(q.asOf).toLocaleDateString()}`) : 'no quote'}
                      {' '}· {sym}{(q?.price ?? h.currentPriceBase).toFixed(3)}
                    </div>
                  </div>
                  <div className="amt">
                    {sym}{val.toFixed(0)}
                    <span className={ret >= 0 ? 'pos small' : 'neg small'}> {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%</span>
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
