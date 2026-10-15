// ============================================================================
// Settings — preferences, BYOK LLM keys, security, data, danger zone.
// ============================================================================

import { useEffect, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useAuthStore } from '../auth/AuthProvider';
import { CURRENCIES } from '../domain/enums';
import type { LLMProvider } from '../domain/types';
import type { MemberRow, VaultSyncRow } from '../services/admin';
import { fingerprintSecret } from '../security/vault';

/**
 * Client-facing model label. There is exactly ONE AI config: the admin-set
 * platform default. Every user — admin or not — uses it. No per-user BYOK,
 * no per-user lock. Surface a neutral label so the backend provider/vendor
 * is never revealed in the target user's UI.
 */
function genericModelName(_model?: string): string {
  return 'AI Assistant';
}

export function SettingsView() {
  const store = useVaultStore();
  const auth = useAuthStore();
  const { vault } = store;
  if (!vault) return null;

  const [msg, setMsg] = useState<string | null>(null);

  // change-password form
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwNext2, setPwNext2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  // Danger zone: two-tap armed confirmation. No native dialog — iOS standalone
  // PWAs silently swallow window.confirm(), which made this button a no-op in
  // the installed app. Mirrors the DelButton armed-destructive pattern.
  const [eraseArmed, setEraseArmed] = useState(false);
  useEffect(() => {
    if (!eraseArmed) return;
    const t = window.setTimeout(() => setEraseArmed(false), 2500);
    return () => window.clearTimeout(t);
  }, [eraseArmed]);

  // ---- admin: single shared AI model + member directory. Only the 0003
  // platform-default row matters; there is no per-user BYOK or per-user
  // lock. ----
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [vaultSync, setVaultSync] = useState<VaultSyncRow[]>([]);
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  // Platform-default LLM (0003 migration) — the one and only AI config.
  const [defProvider, setDefProvider] = useState<LLMProvider>(store.defaultLlm?.provider ?? 'none');
  const [defKey, setDefKey] = useState('');
  const [defModel, setDefModel] = useState('');
  // A key already sits in the platform-default row; show it masked so the
  // admin does not re-type it and can read the active model.
  const [defKeyMasked, setDefKeyMasked] = useState(false);
  const [defBusy, setDefBusy] = useState(false);

  // Re-sync the provider/model inputs when the saved row changes (e.g. right
  // after a successful save, or on first mount when a default already exists).
  // The key itself is never auto-filled — only a masked indicator is shown —
  // so the raw secret stays out of the visible input.
  useEffect(() => {
    const def = store.defaultLlm;
    if (!def) return;
    setDefProvider(def.provider);
    setDefModel(def.model ?? '');
    setDefKeyMasked(def.provider !== 'none' && !!def.api_key);
  }, [store.defaultLlm]);

  const myUserId = auth.user?.id ?? '';

  const refreshAdmin = async () => {
    if (!store.isAdminUser || !auth.cloudAvailable || !auth.user) return;
    const [ms, vs, ids] = await Promise.all([
      store.adminMembers(),
      store.adminVaultSync(),
      store.adminIds(),
    ]);
    setMembers(ms);
    setVaultSync(vs);
    setAdminIds(ids);
  };

  useEffect(() => {
    void refreshAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.isAdminUser, auth.cloudAvailable, auth.user?.id]);

  const saveDefaultLlm = async () => {
    setDefBusy(true);
    setAdminMsg(null);
    const k = defKey.trim();
    if (defProvider === 'none') {
      const ok = await store.adminSetLlmDefault('none', '', '', '');
      setDefBusy(false);
      if (ok) {
        setAdminMsg('AI model cleared - everyone now uses the free on-device rule engine.');
        void refreshAdmin();
      } else setAdminMsg('Could not update - you may not be an admin, or the 0003 migration has not been applied yet.');
      return;
    }
    if (!k) {
      // No key typed: fall back to the already-stored key (if any) so the
      // admin can edit the model without re-entering the secret.
      const existing = store.defaultLlm && store.defaultLlm.provider !== 'none' ? store.defaultLlm.api_key : '';
      if (!existing) {
        setDefBusy(false);
        setAdminMsg('An API key is required to set the AI model.');
        return;
      }
      // Re-save with the existing key unchanged (fingerprint it, keep it verbatim).
      const existingFinger = store.defaultLlm!.key_finger || (await fingerprintSecret(existing).catch(() => ''));
      const okReuse = await store.adminSetLlmDefault(defProvider, existing, defModel.trim(), existingFinger);
      setDefBusy(false);
      if (okReuse) {
        setAdminMsg(
          `AI model saved (${defProvider}) - kept the existing stored key (key …${existingFinger}). ` +
          'Every user now runs on it.',
        );
        setDefKey('');
        setDefKeyMasked(false);
        void refreshAdmin();
      } else setAdminMsg('Could not update - you may not be an admin, or the 0003 migration has not been applied yet.');
      return;
    }
    const finger = await fingerprintSecret(k);
    const ok = await store.adminSetLlmDefault(defProvider, k, defModel.trim(), finger);
    setDefBusy(false);
    if (ok) {
      setAdminMsg(
        `AI model saved: ${defProvider}${defModel.trim() ? ' (' + defModel.trim() + ')' : ''} (key …${finger}). ` +
        'It applies to every user automatically - there is no per-user key or model override.',
      );
      setDefKey('');
      setDefKeyMasked(false); // the re-sync effect will re-set it to true once store.defaultLlm refreshes
      void refreshAdmin();
    } else setAdminMsg('Could not update - you may not be an admin, or the 0003 migration has not been applied yet.');
  };

  const prefs = vault.prefs;

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

      <h2 className="section-title">AI assistant</h2>
      <div className="card">
        {store.llmConfig ? (
          // A platform default LLM is set by the admin — every user is on it.
          <div className="notice" style={{ borderColor: 'var(--ok, #2e7d32)' }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
              {store.isAdminUser ? 'AI engine (admin-managed)' : 'AI engine'}
            </div>
            <p className="muted small" style={{ margin: 0, marginBottom: 10 }}>
              {store.isAdminUser
                ? 'The AI model below is the single platform default you manage in the admin section. Every user — including you — runs on it. There is no per-user key or model override.'
                : 'The AI model is set centrally by your administrator. You do not configure it - your expenses are categorized automatically.'}
            </p>
            <div className="list">
              {store.isAdminUser ? (
                <>
                  <div className="row"><span>Provider</span><span className="badge">{store.llmConfig.provider}</span></div>
                  {store.llmConfig.model && (
                    <div className="row"><span>Model</span><span className="muted small">{store.llmConfig.model}</span></div>
                  )}
                </>
              ) : (
                <>
                  {/* Non-admin: never reveal the provider/model identity. */}
                  <div className="row"><span>Provider</span><span className="badge">Managed</span></div>
                  <div className="row"><span>Model</span><span className="muted small">{genericModelName()}</span></div>
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="muted small">
            No AI model is configured yet, so OmniFlow categorizes with the free
            on-device rule engine. An administrator can set the shared model in the
            admin section below - no per-user setup is needed.
          </p>
        )}
        {store.error && (
          <div className="card" style={{ marginTop: 10, borderColor: 'var(--bad)' }}>
            <div className="small" style={{ color: 'var(--bad)' }}>{store.error}</div>
            <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => store.retrySync()}>
              Retry cloud save
            </button>
          </div>
        )}
      </div>

      <h2 className="section-title">Data</h2>
      <div className="card">
        <div className="list">
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

      {store.isAdminUser && auth.cloudAvailable && auth.user && (
        <>
          <h2 className="section-title">Admin - AI model control</h2>
          <div className="card">
            <p className="muted small">
              You are an administrator ({auth.user.email}). This is the ONE AI
              model for the whole app. Every user - including you - runs on it.
              There is no per-user key or model override; set it once here and
              it applies to everyone. Clearing it sends everyone back to the
              free on-device rule engine.
            </p>

            {/* ---- Single platform-default LLM (the only AI config) ---- */}
            <div className="list" style={{ marginBottom: 10 }}>
              <label className="field"><span>Provider</span>
                <select value={defProvider} onChange={(e) => setDefProvider(e.target.value as LLMProvider)}>
                  <option value="none">None (on-device rules)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="adacode">adaCode</option>
                </select>
              </label>
              {defProvider !== 'none' && (
                <>
                  <label className="field">
                    <span>API key</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="password" value={defKey} onChange={(e) => setDefKey(e.target.value)}
                        placeholder={defKeyMasked ? 'already stored - leave blank to keep it' : 'sk-…'} autoComplete="off"
                        style={{ flex: 1 }} />
                      {defKeyMasked && (
                        <span className="badge" style={{ background: 'var(--ok, #2e7d32)', color: '#fff' }}>stored</span>
                      )}
                    </div>
                  </label>
                  <label className="field"><span>Model (optional)</span>
                    <input value={defModel} onChange={(e) => setDefModel(e.target.value)} placeholder="e.g. adacode-3.0-flash" />
                  </label>
                </>
              )}
              <div className="row">
                <button
                  className="btn sm"
                  disabled={defBusy || (defProvider !== 'none' && !defKey.trim() && !defKeyMasked)}
                  onClick={() => void saveDefaultLlm()}
                >
                  {defBusy ? 'Saving…' : defProvider === 'none' ? 'Clear AI model' : 'Save AI model'}
                </button>
                {defProvider !== 'none' && !defKey.trim() && defKeyMasked && (
                  <span className="muted small">Key stays as-is (use the field above to rotate it).</span>
                )}
              </div>
            </div>
            <p className="muted small">
              Currently: {store.defaultLlm && store.defaultLlm.provider !== 'none'
                ? store.defaultLlm.provider + (store.defaultLlm.model ? ' (' + store.defaultLlm.model + ')' : '') + ' · key …' + store.defaultLlm.key_finger
                : 'no AI model - everyone uses the free on-device rule engine'}
            </p>

            {/* ---- Member directory (read-only) ---- */}
            <div className="list">
              <div className="row" style={{ fontWeight: 600 }}>
                <span className="grow">Registered users</span>
                <span className="muted small">{members.length}</span>
              </div>
              {members.map((m) => {
                const isThisAdmin = adminIds.includes(m.user_id);
                const isSelf = m.user_id === myUserId;
                return (
                  <div key={m.user_id} className="row">
                    <div className="grow">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{m.display_name || m.email}</span>
                        {isThisAdmin && <span className="badge">admin</span>}
                        {isSelf && <span className="badge">you</span>}
                      </div>
                      <div className="muted small">{m.email} · on the shared AI model</div>
                    </div>
                  </div>
                );
              })}
              {members.length === 0 && (
                <p className="muted small">No members registered yet.</p>
              )}
            </div>

            {/* ---- Vault sync state (visibility into what each user uploaded) ---- */}
            {vaultSync.length > 0 && (
              <>
                <h3 className="section-title" style={{ marginTop: 14 }}>Vault sync</h3>
                <div className="list">
                  {vaultSync.map((v) => {
                    const m = members.find((x) => x.user_id === v.user_id);
                    return (
                      <div key={v.user_id} className="row">
                        <span className="grow">{m?.display_name || m?.email || v.user_id.slice(0, 8)}</span>
                        <span className="muted small">
                          synced {new Date(v.updated_at).toLocaleString()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {adminMsg && <div className="small muted" style={{ marginTop: 10 }}>{adminMsg}</div>}
          </div>
        </>
      )}

      <h2 className="section-title">Danger zone</h2>
      <div className="card">
        <button
          className={`btn danger sm${eraseArmed ? ' active' : ''}`}
          onClick={() => {
            if (eraseArmed) {
              setEraseArmed(false);
              void store.eraseAll();
            } else {
              setEraseArmed(true);
            }
          }}
          style={eraseArmed ? { background: 'var(--bad)', color: '#fff', borderColor: 'var(--bad)' } : undefined}
        >
          {eraseArmed ? 'Tap again to erase everything' : 'Erase all data'}
        </button>
        {!eraseArmed && (
          <div className="small muted" style={{ marginTop: 8 }}>
            Removes the vault, portfolio, and sync row from this device.
            No undo.
          </div>
        )}
      </div>
    </>
  );
}
