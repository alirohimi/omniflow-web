// ============================================================================
// Investments — platform-agnostic portfolio view + holding CRUD.
// Grouped by platformName, with live quotes and FX-converted base values.
// ============================================================================

import { useMemo, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { fxService } from '../services';
import { CURRENCIES, currencyInfo, formatMoney } from '../domain/enums';
import { IRefresh, IClose, IPlus } from '../icons';
import type { InvestmentAccount, InvestmentHolding } from '../domain/types';

const ASSET_CLASSES = ['equity-us', 'equity-local', 'etf', 'crypto', 'cash', 'mmf'] as const;

export function InvestmentsView() {
  const store = useVaultStore();
  const live = useLiveData();
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
    if (!platform.trim()) return;
    const id = store.addAccount({ platformName: platform.trim(), accountType: acctType });
    setAccountId(id);
    setPlatform('');
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

      <h2 className="section-title">Add account</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 1.5 }}><span>Platform (Luno, IBKR, Moomoo…)</span>
            <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="StashAway" />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Type</span>
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
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ width: '100%', marginTop: 8 }} className="field">
            <option value="">— target account —</option>
            {vault.accounts.map((a) => <option key={a.id} value={a.id}>{a.platformName} ({a.accountType})</option>)}
          </select>
        )}
      </div>

      <h2 className="section-title">Add holding</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 1 }}><span>Symbol</span>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="AAPL / CSPX.L / BTC / 1155.KL" />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Asset class</span>
            <select value={assetClass} onChange={(e) => setAssetClass(e.target.value as typeof assetClass)}>
              {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 1 }}><span>Units</span>
            <input type="number" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="10" />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Avg entry</span>
            <input type="number" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="12.40" />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Holding cur</span>
            <select value={holdCur} onChange={(e) => setHoldCur(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </label>
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={!accountId} onClick={() => void addHolding()}>
          {accountId ? 'Add holding' : 'Create an account first'}
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
                  <button className="del" title="Delete" aria-label="Delete holding" onClick={() => store.deleteHolding(h.id)}><IClose size={16} /></button>
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
