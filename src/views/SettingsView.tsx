// ============================================================================
// Settings — preferences, BYOK LLM keys, security, demo data, danger zone.
// ============================================================================

import { useState } from 'react';
import { useVaultStore } from '../store/store';
import { useAuthStore } from '../auth/AuthProvider';
import { CURRENCIES } from '../domain/enums';

export function SettingsView() {
  const store = useVaultStore();
  const auth = useAuthStore();
  const { vault } = store;
  if (!vault) return null;

  const [provider, setProvider] = useState<'none' | 'openai' | 'anthropic' | 'gemini'>(vault.prefs.llmProvider);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  // change-password form
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwNext2, setPwNext2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  const prefs = vault.prefs;

  const saveLlm = () => {
    store.setLlmKey(provider, provider === 'none' ? '' : key.trim());
    setKey('');
    setMsg(provider === 'none' ? 'LLM key removed — categorization falls back to the on-device rule engine.' : `LLM key stored (${provider}). Categorization now uses the cloud tier.`);
  };

  const changePw = async () => {
    if (pwNext !== pwNext2) {
      setPwMsg('New passwords do not match.');
      return;
    }
    setPwBusy(true);
    setPwMsg(null);
    try {
      await store.changePassword(pwCurrent, pwNext);
      setPwCurrent('');
      setPwNext('');
      setPwNext2('');
      setPwMsg('Password changed. The vault was re-encrypted under the new key.');
    } catch (e) {
      setPwMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <>
      <h2 className="section-title">Preferences</h2>
      <div className="card">
        <label className="field"><span>Display name</span>
          <input value={prefs.displayName} onChange={(e) => store.setPrefs({ displayName: e.target.value })} />
        </label>
        <label className="field"><span>Base currency (all totals convert to this)</span>
          <select value={prefs.baseCurrency} onChange={(e) => store.setPrefs({ baseCurrency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
        </label>
        <div className="list" style={{ marginTop: 12 }}>
          <label className="row">
            <span>Auto-categorize new expenses (AI engine)</span>
            <span className="switch">
              <input type="checkbox" checked={prefs.autoCategorize} onChange={(e) => store.setPrefs({ autoCategorize: e.target.checked })} />
              <span className="track" aria-hidden="true" />
            </span>
          </label>
          <label className="row">
            <span>Advisor rules (overspend, concentration, pace)</span>
            <span className="switch">
              <input type="checkbox" checked={prefs.advisorRules} onChange={(e) => store.setPrefs({ advisorRules: e.target.checked })} />
              <span className="track" aria-hidden="true" />
            </span>
          </label>
        </div>
      </div>

      <h2 className="section-title">AI — bring-your-own key (optional)</h2>
      <div className="card">
        <p className="muted small">
          Without a key, OmniFlow categorizes with the free on-device rule engine.
          Add a key to use the cloud LLM tier. The key is encrypted inside your
          vault — it never leaves this device except to the provider API.
        </p>
        <label className="field"><span>Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            <option value="none">None (on-device rules)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini (free tier)</option>
          </select>
        </label>
        {provider !== 'none' && (
          <label className="field"><span>{prefs.llmKeyFinger ? 'Replace key (current: …' + prefs.llmKeyFinger + ')' : 'API key'}</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" />
          </label>
        )}
        <button className="btn sm" onClick={saveLlm}>Save</button>
        {msg && <div className="small muted" style={{ marginTop: 8 }}>{msg}</div>}
      </div>

      <h2 className="section-title">Data</h2>
      <div className="card">
        <div className="list">
          <button className="btn ghost sm" onClick={() => { store.loadDemo(); setMsg('Demo data loaded.'); }}>Load demo data</button>
          <button className="btn ghost sm" onClick={() => store.lock()}>Lock vault now</button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          {vault.expenses.length} expenses · {vault.holdings.length} holdings · {vault.accounts.length} accounts · updated {new Date(vault.updatedAt).toLocaleString()}
        </p>
      </div>

      <h2 className="section-title">Account &amp; Sync</h2>
      <div className="card">
        {auth.cloudAvailable ? (
          auth.user ? (
            <>
              <div className="list">
                <div className="row">
                  <span>Signed in</span>
                  <span className="muted small">{auth.user.email}</span>
                </div>
                <div className="row">
                  <span>Vault sync</span>
                  <span className="badge">
                    {store.syncState === 'synced' ? 'synced' : store.syncState === 'error' ? 'error' : store.syncState}
                  </span>
                </div>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>
                Your encrypted vault is stored in the database under this
                {auth.user.user_metadata?.display_name
                  ? ` ${auth.user.user_metadata.display_name}'s`
                  : ''}{' '}
                account ({auth.user.email}). Only ciphertext is stored.
              </p>
              <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => void auth.signOut()}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <p className="muted small">
                Not signed in. Sign in or create an account at the top of the
                app to load your vault from the database.
              </p>
            </>
          )
        ) : (
          <p className="muted small">
            Database is not configured. Build the app with{' '}
            <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>{' '}
            to store your encrypted vault in the shared database. Without it
            the vault exists only in this session and is lost on reload.
          </p>
        )}
      </div>

      <h2 className="section-title">Security</h2>
      <div className="card">
        <p className="muted small">
          Everything is encrypted at rest with AES-256-GCM using a key derived
          from your password (PBKDF2, 210k iterations). Only the ciphertext
          is written to the database; your password and decrypted data never
          leave this device. A wrong password fails to decrypt — there is
          no bypass and no recovery.
        </p>
      </div>

      {auth.cloudAvailable && auth.user && (
        <>
          <h2 className="section-title">Change password</h2>
          <div className="card">
            <p className="muted small">
              Your password is the vault key. Changing it re-encrypts the whole
              vault under the new key, so the two can never get out of sync.
              At least 6 characters, must differ from the current one.
            </p>
            <label className="field"><span>Current password</span>
              <input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            </label>
            <label className="field"><span>New password</span>
              <input type="password" value={pwNext} onChange={(e) => setPwNext(e.target.value)} placeholder="min 6 characters" autoComplete="new-password" />
            </label>
            <label className="field"><span>Confirm new password</span>
              <input type="password" value={pwNext2} onChange={(e) => setPwNext2(e.target.value)} placeholder="repeat new password" autoComplete="new-password" />
            </label>
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              disabled={pwBusy || !pwCurrent || !pwNext || !pwNext2}
              onClick={() => void changePw()}
            >
              {pwBusy ? 'Re-encrypting…' : 'Change password'}
            </button>
            {pwMsg && <div className="small muted" style={{ marginTop: 8 }}>{pwMsg}</div>}
          </div>
        </>
      )}

      <h2 className="section-title">Danger zone</h2>
      <div className="card">
        <button className="btn danger sm"
          onClick={() => {
            if (confirm('Erase ALL OmniFlow data from the database? This cannot be undone.')) {
              void store.eraseAll();
            }
          }}>
          Erase all data
        </button>
      </div>
    </>
  );
}
