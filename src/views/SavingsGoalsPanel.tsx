// ============================================================================
// SavingsGoalsPanel — named savings targets with progress bars.
//
// Each goal has a target amount and a `funded` amount (base currency), so the
// panel renders a progress bar per goal. Gated as a Pro feature: the parent
// view only mounts this panel when the entitlement set allows it.
// ============================================================================

import { useState } from 'react';
import { useVaultStore } from '../store/store';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { Disclosure } from '../components/Disclosure';
import { IPlus } from '../icons';
import { currencyInfo, formatMoney } from '../domain/enums';
import type { SavingsGoal } from '../domain/types';

export function SavingsGoalsPanel() {
  const store = useVaultStore();
  const { toast } = useToast();
  const { vault } = store;

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [funded, setFunded] = useState('');
  const [deadline, setDeadline] = useState('');

  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const goals = vault.savingsGoals ?? [];

  const addGoal = () => {
    const t = parseFloat(target);
    const f = parseFloat(funded) || 0;
    if (!name.trim() || !Number.isFinite(t) || t <= 0) {
      toast('Give the goal a name and a positive target amount.', 'err');
      return;
    }
    let dl: number | undefined;
    if (deadline.trim()) {
      const ts = new Date(deadline).getTime();
      if (Number.isFinite(ts)) dl = ts;
    }
    store.addSavingsGoal({
      name: name.trim(),
      target: t,
      funded: f,
      deadline: dl,
      createdAt: Date.now(),
    });
    toast('Goal added.');
    setName('');
    setTarget('');
    setFunded('');
    setDeadline('');
  };

  const bumpFunded = (g: SavingsGoal, delta: number) => {
    const next = Math.max(0, Math.round((g.funded + delta) * 100) / 100);
    store.updateSavingsGoal(g.id, { funded: next });
  };

  const goalRow = (g: SavingsGoal) => {
    const pct = Math.min(100, g.target > 0 ? Math.round((g.funded / g.target) * 100) : 0);
    const met = g.funded >= g.target;
    const dlStr = g.deadline ? new Date(g.deadline).toLocaleDateString() : '';
    return (
      <div className="item" key={g.id}>
        <div className="grow">
          <div className="title">
            {g.name}
            {met ? <span className="chip sm ok" style={{ marginLeft: 8 }}>Met</span> : null}
          </div>
          <div className="meta">
            {formatMoney(g.funded, base)} of {formatMoney(g.target, base)}
            {dlStr ? ` · due ${dlStr}` : ''}
          </div>
          <div className="bar" style={{ marginTop: 6 }}>
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn ghost sm" style={{ padding: '2px 8px' }} onClick={() => bumpFunded(g, -100)} title="Reduce funded by 100">−</button>
            <button className="btn ghost sm" style={{ padding: '2px 8px' }} onClick={() => bumpFunded(g, 100)} title="Add 100 to funded">+</button>
          </div>
          <DelButton label={`Delete ${g.name}`} onConfirm={() => store.deleteSavingsGoal(g.id)} />
        </div>
      </div>
    );
  };

  return (
    <div className="card">
      {goals.length === 0 ? (
        <div className="small muted" style={{ marginBottom: 10 }}>
          No goals yet. Set a target and track progress below.
        </div>
      ) : (
        <div className="list">{goals.map(goalRow)}</div>
      )}

      <Disclosure id="sg-add" title="Add a savings goal">
        <div className="cols" style={{ marginTop: 10 }}>
          <label className="field"><span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="House deposit" />
          </label>
          <label className="field"><span>Target ({base})</span>
            <input type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="50000" />
          </label>
          <label className="field"><span>Funded so far</span>
            <input type="number" inputMode="decimal" value={funded} onChange={(e) => setFunded(e.target.value)} placeholder="0" />
          </label>
          <label className="field"><span>Deadline (optional)</span>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
        </div>
        <button className="btn sm" style={{ width: '100%', marginTop: 12 }} onClick={addGoal}>
          <IPlus size={16} /> Add goal
        </button>
      </Disclosure>
    </div>
  );
}
