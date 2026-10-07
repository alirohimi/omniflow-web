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

  // Cloud is configured: the account gate (or a brief "restoring session"
  // loader) is the entry point — data lives only in the DB, so the old
  // local-only VaultGate must never flash through while we're waiting on
  // Supabase. Once a user is signed in, the single-credential flow takes
  // over: their password auto-creates (first run) or auto-unlocks (returning)
  // the vault; a refresh or manual lock falls through to the one-field gate.
  if (auth.cloudAvailable) {
    if (auth.restoring) {
      return (
        <div className="gate">
          <div className="panel" style={{ textAlign: 'center', padding: '40px 24px' }}>
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
              <span className="spinner" />
            </div>
            <h1>Checking your account…</h1>
            <p className="muted">Restoring your session.</p>
          </div>
        </div>
      );
    }
    if (auth.user === null) {
      return <AccountGate />;
    }
    // signed in: the vault auto-unlocks with the account password; a refresh
    // or manual lock lands on the one-field password gate (VaultGate) below.
  }

  if (store.status !== 'unlocked') return <VaultGate onReady={() => {}} />;

  return (
    <div className="app-shell">
      <header className="brandbar">
        <div className="logo">O</div>
        <div>
          <h1>OmniFlow</h1>
          <div className="sub">
            {base} · {symbol} · encrypted{cloudOn ? ' · stored in your account' : ' · this session only'}
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
            <span className="tab-ico"><t.ico size={20} /></span>
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
