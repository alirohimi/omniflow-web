// ============================================================================
// App shell — crisp top navigation + responsive shell, light/dark theme, tabs.
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
import { CoachView } from './views/CoachView';
import { currencyInfo } from './domain/enums';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IHome, IWallet, ITrend, IGear, ILock, ICoach, ISun, IMoon } from './icons';

type Tab = 'dashboard' | 'expenses' | 'investments' | 'coach' | 'settings';

const TABS: { id: Tab; label: string; ico: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'dashboard', label: 'Home', ico: IHome },
  { id: 'investments', label: 'Portfolio', ico: ITrend },
  { id: 'expenses', label: 'Expenses', ico: IWallet },
  { id: 'coach', label: 'Coach', ico: ICoach },
  { id: 'settings', label: 'Settings', ico: IGear },
];

function readSavedTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('of:theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function Shell() {
  const store = useVaultStore();
  const auth = useAuthStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [theme, setTheme] = useState<'dark' | 'light'>(readSavedTheme);
  const base = store.vault?.prefs.baseCurrency ?? 'MYR';
  const symbol = currencyInfo(base).symbol;
  const cloudOn = auth.cloudAvailable && store.cloudSynced;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('of:theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Auto-lock: disabled on the user's request. The vault stays unlocked on an
  // open session across idle periods. Manual lock (the lock button / "Lock now")
  // and sign-out remain the only ways to re-arm the gate. To re-enable:
  //   window.setTimeout(() => store.lock(), 5 * 60 * 1000) on pointerdown-idle.
  useEffect(() => {
    // no-op — auto-lock intentionally removed
  }, []);

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

  const syncLabel = !cloudOn
    ? 'Session only'
    : store.syncState === 'syncing'
      ? 'Syncing…'
      : store.syncState === 'error'
        ? 'Sync error'
        : 'Encrypted & Synced';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <div className="logo">O</div>
            <div>
              <div className="topbar-title-row">
                <h1>OmniFlow</h1>
                <span className={`status-pill${store.syncState === 'error' ? ' err' : ''}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {base} ({symbol}) · {syncLabel}
                </span>
              </div>
            </div>
          </div>

          <nav className="topnav" aria-label="Primary navigation">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`topnav-btn${tab === t.id ? ' on' : ''}`}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <t.ico size={16} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="topbar-actions">
            <button
              type="button"
              className="theme-btn"
              onClick={() => setTheme((m) => (m === 'dark' ? 'light' : 'dark'))}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <ISun size={15} /> : <IMoon size={15} />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <button
              className="lockbtn"
              title="Lock now"
              aria-label="Lock the app now (wipes in-memory passphrase; re-asked on return)"
              onClick={() => store.lock()}
            >
              <ILock size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="content">
        {store.error && store.cloudSynced && (
          <div
            role="alert"
            className="alert-banner"
          >
            <span style={{ flex: 1, minWidth: 180 }}>{store.error}</span>
            <button
              className="btn ghost sm"
              style={{ padding: '4px 12px' }}
              onClick={() => store.retrySync()}
            >
              Retry
            </button>
          </div>
        )}
        {tab === 'dashboard' && (
          <ErrorBoundary context="Home"><DashboardView onOpenTab={setTab} /></ErrorBoundary>
        )}
        {tab === 'expenses' && (
          <ErrorBoundary context="Expenses"><ExpensesView /></ErrorBoundary>
        )}
        {tab === 'investments' && (
          <ErrorBoundary context="Portfolio"><InvestmentsView /></ErrorBoundary>
        )}
        {tab === 'coach' && (
          <ErrorBoundary context="Coach"><CoachView /></ErrorBoundary>
        )}
        {tab === 'settings' && (
          <ErrorBoundary context="Settings"><SettingsView /></ErrorBoundary>
        )}
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
