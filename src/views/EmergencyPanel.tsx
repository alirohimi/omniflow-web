// ============================================================================
// EmergencyPanel — the emergency-reserve module's control surface.
//
// Two kinds of lines:
//   account  a designated tracked portfolio account (live value, FX-aware;
//            an empty / cash-only / money-market account counts as liquid,
//            anything invested counts as invested).
//   manual   a static snapshot the user maintains (e.g. "bank HYSA RM20k").
//
// Coverage is measured against essential spend (insights/emergency.ts), and
// the target is derived (months of essentials) or pinned by the user. Every
// mutation goes through the store so it encrypts + syncs like the rest of
// the vault.
// ============================================================================

import { useMemo, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { Disclosure } from '../components/Disclosure';
import { IPlus } from '../icons';
import { CURRENCIES, currencyInfo, formatMoney, EMERGENCY_DEFAULT } from '../domain/enums';
import { computeEmergency } from '../insights';
import type { EmergencyFundItem, EmergencyFund } from '../domain/types';

const STATUS_COPY: Record<string, string> = {
  none: 'No lines yet',
  building: 'Building',
  ok: 'Target met',
  over: 'Ahead of target',
};

export function EmergencyPanel() {
  const store = useVaultStore();
  const live = useLiveData();
  const { toast } = useToast();
  const { vault } = store;
  const [kind, setKind] = useState<'account' | 'manual'>('manual');
  const [mName, setMName] = useState('');
  const [mAmount, setMAmount] = useState('');
  const [mCur, setMCur] = useState(vault?.prefs.baseCurrency ?? 'MYR');
  const [aAccount, setAAccount] = useState('');
  const [months, setMonths] = useState('');
  const [override, setOverride] = useState('');

  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const em = vault.emergency ?? EMERGENCY_DEFAULT;
  const now = Date.now();

  const res = useMemo(
    () =>
      computeEmergency({
        emergency: em,
        expenses: vault.expenses,
        accounts: vault.accounts,
        portfolio: live.portfolio,
        fx: live.fx,
        base,
        now,
      }),
    [em, vault.expenses, vault.accounts, live.portfolio, live.fx, base, now],
  );

  const addLine = () => {
    let input: Omit<EmergencyFundItem, 'id'>;
    if (kind === 'manual') {
      const amt = parseFloat(mAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        toast('Enter a positive amount.', 'err');
        return;
      }
      input = {
        kind: 'manual',
        name: mName.trim() || 'Manual reserve',
        currency: mCur,
        amount: amt,
        createdAt: Date.now(),
      };
    } else {
      if (!aAccount) {
        toast('Pick an account to designate.', 'err');
        return;
      }
      const acct = vault.accounts.find((a) => a.id === aAccount);
      input = {
        kind: 'account',
        name: acct?.platformName || 'Account',
        currency: base,
        accountId: aAccount,
        createdAt: Date.now(),
      };
    }
    store.addEmergencyItem(input);
    toast('Reserve line added.');
    if (kind === 'manual') {
      setMName('');
      setMAmount('');
    } else {
      setAAccount('');
    }
  };

  const saveTarget = () => {
    const patch: Partial<Omit<EmergencyFund, 'items'>> = {};
    if (months.trim() !== '') {
      const m = Math.round(parseFloat(months));
      if (Number.isFinite(m) && m >= 1 && m <= 12) {
        patch.targetMonths = m;
      } else {
        toast('Months must be 1-12.', 'err');
        return;
      }
    }
    if (override.trim() === '') {
      patch.targetOverrideBase = undefined; // clear a pin
    } else {
      const o = parseFloat(override);
      if (Number.isFinite(o) && o > 0) patch.targetOverrideBase = o;
      else {
        toast('Enter a positive target amount, or leave blank to derive it.', 'err');
        return;
      }
    }
    store.setEmergency(patch);
    setMonths('');
    setOverride('');
    toast('Target updated.');
  };

  const sym = currencyInfo(base).symbol;
  const pct = Math.min(100, Math.round(res.pctOfTarget));

  return (
    <div className="card">
      <div className="hero">
        <div>
          <div className="hero-lbl">Emergency reserve · {base}</div>
          <div className="hero-num">{formatMoney(res.reserve, base)}</div>
          <div className="hero-sub">
            <span className={res.status === 'building' || res.status === 'none' ? 'neg' : 'pos'}>
              {res.coverageMonths != null
                ? `${res.coverageMonths.toFixed(1)} months of essentials`
                : 'no essential spend recorded yet'}
            </span>
          </div>
        </div>
        <span className={`chip sm ${res.status === 'ok' || res.status === 'over' ? 'ok' : ''}`}>
          {STATUS_COPY[res.status]}
        </span>
      </div>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="row small muted meta-row">
        <span>
          Target {formatMoney(res.target, base)}
          {res.targetSource === 'override'
            ? ' (pinned)'
            : res.targetSource === 'zero-spend'
              ? ' (no spend base)'
              : ` (${res.targetMonths} mo × ${sym}${res.monthlyEssential.toFixed(0)})`}
        </span>
        <span>
          {sym}{res.liquidValue.toFixed(0)} liquid · {sym}{res.investedValue.toFixed(0)} invested
        </span>
        {res.gap > 0 ? <span className="neg">gap {formatMoney(res.gap, base)}</span> : null}
      </div>

      <h2 className="section-title">Reserve lines</h2>
      {res.lines.length === 0 ? (
        <div className="small muted" style={{ marginBottom: 10 }}>
          No lines yet. Designate a tracked account or record a manual amount.
        </div>
      ) : (
        <div className="list">
          {res.lines.map((l) => (
            <div className="item" key={l.id}>
              <div className="grow">
                <div className="title">
                  {l.name}
                  {l.kind === 'account' ? (
                    <span className="chip sm" style={{ marginLeft: 8 }}>{l.live ? 'live' : 'no data'}</span>
                  ) : null}
                  <span className="chip sm" style={{ marginLeft: 8 }}>
                    {l.liquid ? 'liquid' : 'invested'}
                  </span>
                </div>
                <div className="meta">
                  {l.kind === 'account'
                    ? 'mirrors a tracked account'
                    : `${formatMoney(l.valueLocal, l.currency)} in ${l.currency}`}
                </div>
              </div>
              <div className="amt">{formatMoney(l.valueBase, base)}</div>
              <DelButton label={`Remove ${l.name}`} onConfirm={() => store.deleteEmergencyItem(l.id)} />
            </div>
          ))}
        </div>
      )}

      <Disclosure id="em-addline" title="Add a reserve line">
      <div className="row" style={{ marginTop: 14 }}>
        <span>Reserve line type</span>
        <span className="switch">
          <input
            id="em-kind"
            type="checkbox"
            checked={kind === 'account'}
            onChange={() => setKind((k) => (k === 'account' ? 'manual' : 'account'))}
          />
          <span className="track" aria-hidden="true" />
        </span>
        <span className="small muted">{kind === 'account' ? 'Designate an account' : 'Manual amount'}</span>
      </div>

      {kind === 'manual' ? (
        <div className="cols" style={{ marginTop: 12 }}>
          <label className="field"><span>Name</span>
            <input value={mName} onChange={(e) => setMName(e.target.value)} placeholder="Bank HYSA" />
          </label>
          <label className="field"><span>Amount</span>
            <input type="number" inputMode="decimal" value={mAmount} onChange={(e) => setMAmount(e.target.value)} placeholder="20000" />
          </label>
          <label className="field"><span>Currency</span>
            <select value={mCur} onChange={(e) => setMCur(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {vault.accounts.length === 0 ? (
            <div className="small muted" style={{ marginBottom: 8 }}>
              No tracked accounts yet — add one under Portfolio first.
            </div>
          ) : (
            <label className="field"><span>Account</span>
              <select value={aAccount} onChange={(e) => setAAccount(e.target.value)}>
                <option value="">Pick an account…</option>
                {vault.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.platformName}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <button className="btn sm" style={{ width: '100%', marginTop: 12 }} onClick={addLine}>
        <IPlus size={16} /> Add reserve line
      </button>
      </Disclosure>

      <Disclosure id="em-target" title="Reserve target">
      <h2 className="section-title">Target</h2>
      <div className="cols">
        <label className="field"><span>Months of essentials</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={12}
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            placeholder={String(em.targetMonths)}
          />
        </label>
        <label className="field"><span>Pinned target ({base})</span>
          <input
            type="number"
            inputMode="decimal"
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder={em.targetOverrideBase != null ? String(em.targetOverrideBase) : 'auto (derived)'}
          />
        </label>
      </div>
      <button className="btn ghost sm" style={{ width: '100%', marginTop: 10 }} onClick={saveTarget}>
        Save target
      </button>
      <div className="small muted" style={{ marginTop: 8 }}>
        Months multiplies your 90-day essential spend. A pinned target overrides the months figure when set;
        clear it to go back to derived.
      </div>
      </Disclosure>
    </div>
  );
}
