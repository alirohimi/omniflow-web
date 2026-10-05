// ============================================================================
// App shell — brand bar, tab navigation, content, PWA install hint.
// ============================================================================

import { useEffect, useState } from 'react';
import { VaultProvider, useVaultStore } from './store/store';
import { VaultGate } from './views/VaultGate';
import { DashboardView } from './views/DashboardView';
import { ExpensesView } from './views/ExpensesView';
import { InvestmentsView } from './views/InvestmentsView';
import { SettingsView } from './views/SettingsView';
import { currencyInfo } from './domain/enums';

type Tab = 'dashboard' | 'expenses' | 'investments' | 'settings';

const TABS: { id: Tab; label: string; ico: string }[] = [
  { id: 'dashboard', label: 'Home', ico: '🏠' },
  { id: 'expenses', label: 'Expenses', ico: '🧾' },
  { id: 'investments', label: 'Portfolio', ico: '📈' },
  { id: 'settings', label: 'Settings', ico: '⚙️' },
];

function Shell() {
  const store = useVaultStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const base = store.vault?.prefs.baseCurrency ?? 'MYR';
  const symbol = currencyInfo(base).symbol;

  // Auto-lock: re-arm the vault gate after 5 min of idle (client-side only,
  // so no data leaves the device; this is the web analogue of the LAContext
  // app-lock on iOS).
  useEffect(() => {
    if (store.status !== 'unlocked') return;
    let timer: number | undefined;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => store.lock(), 5 * 60 * 1000);
    };
    reset();
    window.addEventListener('pointerdown', reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
    };
  }, [store]);

  if (store.status !== 'unlocked') return <VaultGate onReady={() => {}} />;

  return (
    <div className="app-shell">
      <header className="brandbar">
        <div className="logo">O</div>
        <div>
          <h1>OmniFlow</h1>
          <div className="sub">
            {base} · {symbol} · encrypted locally
          </div>
        </div>
      </header>

      <main className="content">
        {tab === 'dashboard' && <DashboardView onOpenTab={setTab} />}
        {tab === 'expenses' && <ExpensesView />}
        {tab === 'investments' && <InvestmentsView />}
        {tab === 'settings' && <SettingsView />}
      </main>

      <nav className="tabbar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-current={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span className="ico">{t.ico}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <VaultProvider>
      <Shell />
    </VaultProvider>
  );
}
