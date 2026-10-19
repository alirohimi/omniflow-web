// ============================================================================
// AutoInvestPanel — standing "invest X every period into this account" plans.
//
// Each plan targets one investment account (the "selected portfolio"). When a
// cycle falls due, the panel surfaces it with a "Log now" action (and settles
// automatically on mount via settleDue). Settling writes ONE contribution row
// to the ledger and grows the account's invested capital (initialDepositBase),
// which is exactly what the portfolio P&L measures against — so monthly
// savings keep the profit/loss number honest forever.
//
// A manual "Log a contribution" form covers ad-hoc top-ups (same ledger, no
// plan needed). The ledger below shows every logged contribution per account.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { Disclosure } from '../components/Disclosure';
import { IPlus } from '../icons';
import { fxService, type RatesForBase } from '../services';
import { CURRENCIES, currencyInfo, formatMoney } from '../domain/enums';
import { dueAutoInvests, advanceNextDue, periodsBetween, autoInvestMonthlyTotal } from '../insights';
import type { AutoInvest, AutoInvestPeriod, Contribution } from '../domain/types';

const PERIODS: { v: AutoInvestPeriod; label: string }[] = [
  { v: 'weekly', label: 'Weekly' },
  { v: 'monthly', label: 'Monthly' },
  { v: 'quarterly', label: 'Quarterly' },
  { v: 'yearly', label: 'Yearly' },
];

export function AutoInvestPanel({ fx }: { fx: RatesForBase | null }) {
  const store = useVaultStore();
  const { toast } = useToast();
  const { vault } = store;

  // ---- plan form state
  const [planName, setPlanName] = useState('');
  const [planAcc, setPlanAcc] = useState('');
  const [planAmt, setPlanAmt] = useState('');
  const [planCur, setPlanCur] = useState('');
  const [planPeriod, setPlanPeriod] = useState<AutoInvestPeriod>('monthly');
  const [planStart, setPlanStart] = useState('');

  // ---- manual contribution form state
  const [manAcc, setManAcc] = useState('');
  const [manAmt, setManAmt] = useState('');
  const [manCur, setManCur] = useState('');

  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const sym = currencyInfo(base).symbol;
  const plans = vault.autoInvests ?? [];
  const ledger = vault.contributions ?? [];
  const accounts = vault.accounts;

  // FX: live rates from useLiveData when available; fall back to a fetch.
  const rateFor = (code: string): number => {
    if (fx) return fxService.toBase(1, code, fx);
    return code === base ? 1 : NaN;
  };

  // ---- auto-settle due plans once per mount (per plan: log ONE cycle and
  //      advance nextDue; a long offline gap settles one cycle per load).
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current) return;
    settled.current = true;
    const now = Date.now();
    const due = dueAutoInvests(plans, now);
    for (const p of due) {
      const acc = accounts.find((a) => a.id === p.accountId);
      if (!acc) continue;
      store.addContribution({
        accountId: p.accountId,
        planId: p.id,
        amount: p.amount,
        currency: p.currency,
        amountBase: p.baseAmount,
        fxRate: p.fxRate,
        date: now,
        note: `Auto-settled plan: ${p.name}`,
      });
      store.updateAutoInvest(p.id, { nextDue: advanceNextDue(p, now) });
    }
    if (due.length > 0) {
      toast(
        due.length === 1
          ? `Auto-invest logged: ${formatMoney(due[0].baseAmount, base)} → ${accounts.find((a) => a.id === due[0].accountId)?.platformName ?? 'account'}`
          : `${due.length} auto-invest cycles logged.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dueIds = useMemo(() => new Set(dueAutoInvests(plans, Date.now()).map((p) => p.id)), [plans]);

  const monthlyTotal = useMemo(() => autoInvestMonthlyTotal(plans), [plans]);

  // ---- form actions
  const addPlan = () => {
    const amt = parseFloat(planAmt);
    const acc = accounts.find((a) => a.id === planAcc);
    if (!acc) { toast('Pick a target account for the plan.', 'err'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a positive amount.', 'err'); return; }
    const cur = planCur || base;
    const rate = cur === base ? 1 : rateFor(cur);
    if (!Number.isFinite(rate)) { toast(`No FX rate for ${cur} yet — try again in a moment.`, 'err'); return; }
    let nextDue: number;
    if (planStart.trim()) {
      const ts = new Date(planStart + 'T00:00:00').getTime();
      nextDue = Number.isFinite(ts) ? ts : Date.now();
    } else {
      nextDue = Date.now();
    }
    store.addAutoInvest({
      accountId: acc.id,
      name: planName.trim() || `${acc.platformName} top-up`,
      amount: amt,
      currency: cur,
      baseAmount: amt * rate,
      fxRate: rate,
      period: planPeriod,
      nextDue,
      active: true,
      createdAt: Date.now(),
    });
    toast(`Plan created: ${formatMoney(amt * rate, base)} ${planPeriod} → ${acc.platformName}.`);
    setPlanName(''); setPlanAmt(''); setPlanStart('');
  };

  const logPlanNow = (p: AutoInvest) => {
    const acc = accounts.find((a) => a.id === p.accountId);
    if (!acc) return;
    store.addContribution({
      accountId: p.accountId,
      planId: p.id,
      amount: p.amount,
      currency: p.currency,
      amountBase: p.baseAmount,
      fxRate: p.fxRate,
      date: Date.now(),
      note: `Plan: ${p.name}`,
    });
    store.updateAutoInvest(p.id, { nextDue: advanceNextDue(p, Date.now()) });
    toast(`Logged ${formatMoney(p.baseAmount, base)} → ${acc.platformName}.`);
  };

  const addManual = () => {
    const amt = parseFloat(manAmt);
    const acc = accounts.find((a) => a.id === manAcc);
    if (!acc) { toast('Pick the account you invested into.', 'err'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a positive amount.', 'err'); return; }
    const cur = manCur || base;
    const rate = cur === base ? 1 : rateFor(cur);
    if (!Number.isFinite(rate)) { toast(`No FX rate for ${cur} yet — try again in a moment.`, 'err'); return; }
    store.addContribution({
      accountId: acc.id,
      amount: amt,
      currency: cur,
      amountBase: amt * rate,
      fxRate: rate,
      date: Date.now(),
      note: 'Manual contribution',
    });
    toast(`Logged ${formatMoney(amt, cur)} → ${acc.platformName}. P&L updated.`);
    setManAmt('');
  };

  const periodLabel = (p: AutoInvestPeriod) => PERIODS.find((x) => x.v === p)?.label.toLowerCase() ?? p;

  const planRow = (p: AutoInvest) => {
    const acc = accounts.find((a) => a.id === p.accountId);
    const overdue = periodsBetween(p.period, p.nextDue, Date.now());
    const due = dueIds.has(p.id);
    return (
      <div className={`item${due ? ' picked' : ''}`} key={p.id}>
        <div className="grow">
          <div className="title">
            {p.name}
            {p.active === false ? <span className="chip sm" style={{ marginLeft: 8 }}>paused</span> : null}
            {due && p.active !== false ? <span className="chip sm ok" style={{ marginLeft: 8 }}>due</span> : null}
          </div>
          <div className="meta">
            {formatMoney(p.amount, p.currency)}{p.currency !== base ? ` (${sym}${p.baseAmount.toFixed(0)})` : ''} · {periodLabel(p.period)} · → {acc?.platformName ?? 'deleted account'}
            {' · next '}
            {new Date(p.nextDue).toLocaleDateString()}
            {overdue > 0 ? ` (${overdue} cycle${overdue === 1 ? '' : 's'} overdue)` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn ghost sm" style={{ padding: '2px 10px' }} onClick={() => logPlanNow(p)} title="Log this cycle now">
              Log now
            </button>
            <button
              className="btn ghost sm"
              style={{ padding: '2px 10px' }}
              onClick={() => store.updateAutoInvest(p.id, { active: p.active === false })}
              title={p.active === false ? 'Resume plan' : 'Pause plan'}
            >
              {p.active === false ? 'Resume' : 'Pause'}
            </button>
          </div>
          <DelButton label={`Delete plan ${p.name}`} onConfirm={() => store.deleteAutoInvest(p.id)} />
        </div>
      </div>
    );
  };

  const accSel = (value: string, onChange: (v: string) => void, label: string) => (
    <label className="field"><span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select account…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.platformName}</option>)}
      </select>
    </label>
  );

  const curSel = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {[...new Set([base, ...CURRENCIES.map((c) => c.code)])].map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </select>
  );

  const ledgerFor = (accId: string): Contribution[] =>
    ledger.filter((c) => c.accountId === accId).sort((a, b) => b.date - a.date);

  return (
    <div className="card">
      {plans.length > 0 && (
        <div className="row small" style={{ marginBottom: 8, gap: 8 }}>
          <span className="chip sm">Committing {formatMoney(monthlyTotal, base)}/mo equivalent</span>
        </div>
      )}
      {plans.length === 0 ? (
        <div className="small muted" style={{ marginBottom: 10 }}>
          No auto-invest plans yet. Create one — e.g. "{sym}500 monthly into Luno" — and every
          cycle is logged as invested capital, so your P&L stays accurate automatically.
        </div>
      ) : (
        <div className="list">{plans.map(planRow)}</div>
      )}

      <Disclosure id="ai-add-plan" title="Create an auto-invest plan">
        <div className="cols" style={{ marginTop: 10 }}>
          <label className="field"><span>Plan name</span>
            <input value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="Monthly Luno top-up" />
          </label>
          {accSel(planAcc, setPlanAcc, 'Target account')}
          <label className="field"><span>Amount</span>
            <input type="number" inputMode="decimal" value={planAmt} onChange={(e) => setPlanAmt(e.target.value)} placeholder="500" />
          </label>
          <label className="field"><span>Currency</span>
            {curSel(planCur || base, setPlanCur)}
          </label>
          <label className="field"><span>Frequency</span>
            <select value={planPeriod} onChange={(e) => setPlanPeriod(e.target.value as AutoInvestPeriod)}>
              {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
          </label>
          <label className="field"><span>First due (optional)</span>
            <input type="date" value={planStart} onChange={(e) => setPlanStart(e.target.value)} />
          </label>
        </div>
        <button className="btn sm" style={{ width: '100%', marginTop: 12 }} onClick={addPlan}>
          <IPlus size={16} /> Create plan
        </button>
      </Disclosure>

      <Disclosure id="ai-manual" title="Log a one-off contribution">
        <div className="small muted" style={{ marginTop: 10 }}>
          Already moved money in yourself? Log it here — invested capital grows and P&L
          stays measured against what you actually put in.
        </div>
        <div className="cols">
          {accSel(manAcc, setManAcc, 'Account')}
          <label className="field"><span>Amount</span>
            <input type="number" inputMode="decimal" value={manAmt} onChange={(e) => setManAmt(e.target.value)} placeholder="1000" />
          </label>
          <label className="field"><span>Currency</span>
            {curSel(manCur || base, setManCur)}
          </label>
        </div>
        <button className="btn sm" style={{ width: '100%', marginTop: 12 }} onClick={addManual}>
          <IPlus size={16} /> Log contribution
        </button>
      </Disclosure>

      {ledger.length > 0 && (
        <Disclosure id="ai-ledger" title={`Contribution history (${ledger.length})`}>
          <div className="list" style={{ marginTop: 10 }}>
            {accounts.map((a) => {
              const rows = ledgerFor(a.id);
              if (rows.length === 0) return null;
              const sum = rows.reduce((s, c) => s + (Number.isFinite(c.amountBase) ? c.amountBase : 0), 0);
              return (
                <div key={a.id} style={{ marginBottom: 10 }}>
                  <div className="small" style={{ fontWeight: 650, marginBottom: 4 }}>
                    {a.platformName} · {rows.length} contribution{rows.length === 1 ? '' : 's'} · {formatMoney(sum, base)} invested
                  </div>
                  {rows.slice(0, 10).map((c) => (
                    <div className="item" key={c.id} style={{ padding: '8px 12px' }}>
                      <div className="grow">
                        <div className="meta">
                          {new Date(c.date).toLocaleDateString()} · {c.note ?? (c.planId ? 'plan' : 'manual')}
                        </div>
                      </div>
                      <div className="amt">{formatMoney(c.amountBase, base)}</div>
                      <DelButton
                        label={`Remove contribution ${c.id}`}
                        onConfirm={() => {
                          // Removing a contribution also shrinks the account's
                          // invested capital so P&L stays consistent.
                          const acc = accounts.find((x) => x.id === c.accountId);
                          if (acc && acc.initialDepositBase != null) {
                            store.updateAccount(c.accountId, {
                              initialDepositBase: Math.max(0, acc.initialDepositBase - c.amountBase),
                            });
                          }
                          store.deleteContribution(c.id);
                          toast('Contribution removed; capital adjusted.');
                        }}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
