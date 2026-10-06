// ============================================================================
// App shell — brand bar, tab navigation (SVG icons), content, PWA install hint.
// ============================================================================

import { useEffect, useState } from 'react';
import { VaultProvider, useVaultStore } from './store/store';
import { AuthProvider, useAuthStore } from './auth/AuthProvider';
import { ToastProvider } from './components/Toast';
import { VaultGate } from './views/VaultGate';
import { AccountGate } from './views/AccountGate';
import { DashboardView } from './views/DashboardView';
import { ExpensesView } from './views/ExpensesView';
import { InvestmentsView } from './views/InvestmentsView';
import { SettingsView } from './views/SettingsView';
import { currencyInfo } from './domain/enums';
import { IHome, IWallet, ITrend, IGear, ILock } from './icons';

type Tab = 'dashboard' | 'expenses' | 'investments' | 'settings';

const TABS: { id: Tab; label: string; ico: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'dashboard', label: 'Home', ico: IHome },
  { id: 'expenses', label: 'Expenses', ico: IWallet },
  { id: 'investments', label: 'Portfolio', ico: ITrend },
  { id: 'settings', label: 'Settings', ico: IGear },
];

function Shell() {
  const store = useVaultStore();
  const auth = useAuthStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const base = store.vault?.prefs.baseCurrency ?? 'MYR';
  const symbol = currencyInfo(base).symbol;
  const cloudOn = auth.cloudAvailable && store.cloudSynced;

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

  // Cloud is configured, no account signed in, and the user hasn't opted into
  // local-only mode: pick an account (or continue on this device) first.
  if (auth.cloudAvailable && auth.user === null && !auth.restoring && !auth.localMode) {
    return <AccountGate />;
  }

  if (store.status !== 'unlocked') return <VaultGate onReady={() => {}} />;

  return (
    <div className="app-shell">
      <header className="brandbar">
        <div className="logo">O</div>
        <div>
          <h1>OmniFlow</h1>
          <div className="sub">
            {base} · {symbol} · encrypted locally
            {cloudOn ? ' · cloud sync on' : ''}
          </div>
        </div>
        <button
          className="lockbtn"
          title="Lock now"
          aria-label="Lock the app now (wipes in-memory passphrase; re-asked on return)"
          onClick={() => store.lock()}
        >
          <ILock size={18} />
        </button>
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
            <t.ico size={20} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  // AuthProvider must wrap VaultProvider: the vault store reads the current
  // user id (from auth) to scope both its offline cache and cloud sync.
  return (
    <AuthProvider>
      <VaultProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </VaultProvider>
    </AuthProvider>
  );
}
