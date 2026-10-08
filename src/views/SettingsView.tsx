// ============================================================================
// Settings — preferences, BYOK LLM keys, security, data, danger zone.
// ============================================================================

import { useEffect, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useAuthStore } from '../auth/AuthProvider';
import { CURRENCIES } from '../domain/enums';
import { testLLMKey } from '../ai';
import type { LLMConfig } from '../ai/categorize';
import type { LLMProvider } from '../domain/types';
import type { MemberRow, VaultSyncRow, PolicySummary } from '../services/admin';
import { fingerprintSecret } from '../security/vault';

export function SettingsView() {
  const store = useVaultStore();
  const auth = useAuthStore();
  const { vault } = store;
  if (!vault) return null;

  const [provider, setProvider] = useState<'none' | 'openai' | 'anthropic' | 'gemini' | 'adacode'>(vault.prefs.llmProvider);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(vault.prefs.llmModel ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  // change-password form
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwNext2, setPwNext2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  // ---- admin: LLM policy + member directory (only when the 0002 migration
  // has been applied AND this user is signed in to the shared DB). ----
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [vaultSync, setVaultSync] = useState<VaultSyncRow[]>([]);
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [policies, setPolicies] = useState<Record<string, PolicySummary>>({});
  const [lockBusy, setLockBusy] = useState(false);
  const [lockKey, setLockKey] = useState('');
  const [lockModel, setLockModel] = useState('');
  const [lockProvider, setLockProvider] = useState<LLMProvider>('none');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  // Effective admin-assigned policy for the signed-in user. When present, the
  // BYOK section above is read-only and the key/model come from the admin,
  // not from this user's vault. 'none' + no key = admin forced on-device.
  const myUserId = auth.user?.id ?? '';
  const myPolicy = myUserId ? store.llmPolicy : undefined;
  const llmLocked = !!myPolicy;

  const refreshAdmin = async () => {
    if (!store.isAdminUser || !auth.cloudAvailable || !auth.user) return;
    const [ms, vs, ids, ps] = await Promise.all([
      store.adminMembers(),
      store.adminVaultSync(),
      store.adminIds(),
      store.adminPolicies(),
    ]);
    setMembers(ms);
    setVaultSync(vs);
    setAdminIds(ids);
    const map: Record<string, PolicySummary> = {};
    for (const p of ps) map[p.user_id] = p;
    setPolicies(map);
  };

  useEffect(() => {
    void refreshAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.isAdminUser, auth.cloudAvailable, auth.user?.id]);

  const setLockFor = async (member: MemberRow, provider: LLMProvider) => {
    setLockBusy(true);
    setAdminMsg(null);
    const k = lockKey.trim();
    if (provider === 'none') {
      // 'none' + no key = unlock (admin forces on-device rules / local BYOK).
      const ok = await store.adminClearLlm(member.user_id);
      setLockBusy(false);
      if (ok) {
        setAdminMsg(`${member.display_name || member.email}: LLM unlocked (use own key / on-device rules).`);
        void refreshAdmin();
      } else setAdminMsg('Could not update - you may not be an admin.');
      return;
    }
    if (!k) {
      setLockBusy(false);
      setAdminMsg('An API key is required to lock a user to a cloud provider.');
      return;
    }
    const finger = await fingerprintSecret(k);
    const ok = await store.adminSetLlm(member.user_id, provider, k, lockModel.trim(), finger);
    setLockBusy(false);
    if (ok) {
      setAdminMsg(`${member.display_name || member.email}: locked to ${provider}${lockModel.trim() ? ' (' + lockModel.trim() + ')' : ''}.`);
      // Mask the key immediately: the fingerprint + provider badge on the row
      // confirm the policy; there is no reason for the raw key to stay
      // visible in the field (re-enter it if you lock the next user).
      setLockKey('');
      void refreshAdmin();
    } else setAdminMsg('Could not update - you may not be an admin.');
  };

  const unlockUser = async (member: MemberRow) => {
    setLockBusy(true);
    const ok = await store.adminClearLlm(member.user_id);
    setLockBusy(false);
    setAdminMsg(ok ? `${member.display_name || member.email}: LLM policy cleared.` : 'Could not update.');
    if (ok) void refreshAdmin();
  };

  const prefs = vault.prefs;

  const saveLlm = async () => {
    const k = key.trim();
    const ok = await store.setLlmKey(provider, provider === 'none' ? '' : k, model.trim() || undefined);
    setTestResult(null);
    if (!ok) {
      setMsg('Could not save - the vault is not unlocked.');
      return;
    }
    setKey('');
    setMsg(provider === 'none' ? 'LLM key removed - categorization falls back to the on-device rule engine.' : `LLM key stored (${provider}). Categorization now uses the cloud tier.`);
    // A cloud-sync failure must be explicit, not silent: check the store state
    // a beat later (persist is asynchronous) and say so.
    setTimeout(() => {
      if (store.syncState === 'error') {
        setMsg('Saved in memory, but cloud sync failed - your account could not be reached. Use Retry before closing the tab.');
      }
    }, 350);
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    const cfg: LLMConfig = {
      provider,
      apiKey: key.trim() || store.llmConfig?.apiKey || '',
      model: model.trim() || undefined,
    };
    const r = await testLLMKey(cfg);
    setTestResult(r);
    setTesting(false);
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
        {llmLocked && myPolicy ? (
          <div className="notice" style={{ borderColor: 'var(--warn, #b8860b)' }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
              Locked by your admin
            </div>
            <p className="muted small" style={{ margin: 0, marginBottom: 10 }}>
              An administrator has set the AI model for this account. It overrides
              the personal key below until they clear it.
            </p>
            <div className="list">
              <div className="row"><span>Provider</span><span className="badge">{myPolicy.provider}</span></div>
              {myPolicy.model && (
                <div className="row"><span>Model</span><span className="muted small">{myPolicy.model}</span></div>
              )}
              {myPolicy.key_finger && (
                <div className="row"><span>Key</span><span className="muted small">…{myPolicy.key_finger}</span></div>
              )}
            </div>
          </div>
        ) : (
          <>
        <p className="muted small">
          Without a key, OmniFlow categorizes with the free on-device rule engine.
          Add a key to use the cloud LLM tier. The key is encrypted inside your
          vault — it never leaves this device except to the provider API.
        </p>
        <label className="field"><span>Provider</span>
          <select
            value={provider}
            onChange={(e) => {
              // One key at a time: switching provider resets the draft form
              // (different key format, different model names) so an old
              // provider's key is never silently saved under a new provider.
              setProvider(e.target.value as typeof provider);
              setKey('');
              setModel('');
              setTestResult(null);
            }}
          >
            <option value="none">None (on-device rules)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="adacode">adaCode</option>
          </select>
        </label>
        {provider !== 'none' && (
          <>
            <label className="field">
              <span>
                {provider === prefs.llmProvider && prefs.llmKeyFinger
                  ? 'Replace key (current: …' + prefs.llmKeyFinger + ')'
                  : provider !== prefs.llmProvider && prefs.llmKeyFinger
                    ? 'API key (replaces the ' + (prefs.llmProvider === 'none' ? '' : prefs.llmProvider + ' ') + 'key — one active key at a time)'
                    : 'API key'}
              </span>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
            </label>
            <label className="field"><span>Model override (optional - leave blank for the provider default)</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. adacode-3.0-flash, claude-haiku-4-5, gpt-4o-mini, gemini-3.8-flash" />
            </label>
            <div className="list" style={{ marginTop: 8 }}>
              <button
                className="btn ghost sm"
                disabled={testing}
                onClick={() => void testKey()}
              >
                {testing ? 'Testing…' : 'Test key'}
              </button>
            </div>
            {testResult && (
              <div className="small" style={{ marginTop: 6, color: testResult.ok ? 'var(--good)' : 'var(--bad)' }}>
                {testResult.ok ? 'Key works — ' : 'Key failed — '}
                {testResult.detail}
              </div>
            )}
          </>
        )}
        <button className="btn sm" onClick={() => void saveLlm()}>Save</button>
        {msg && <div className="small muted" style={{ marginTop: 8 }}>{msg}</div>}
        {store.error && (
          <div className="card" style={{ marginTop: 10, borderColor: 'var(--bad)' }}>
            <div className="small" style={{ color: 'var(--bad)' }}>{store.error}</div>
            <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => store.retrySync()}>
              Retry cloud save
            </button>
          </div>
        )}
          </>
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
          <h2 className="section-title">Admin — AI model control</h2>
          <div className="card">
            <p className="muted small">
              You are an administrator ({auth.user.email}). Choose which model each
              registered user's AI engine uses. Setting a key here locks that user's
              AI section to your choice — it overrides their personal BYOK key until
              you clear it. Users without a policy keep using their own key or the
              free on-device rules.
            </p>

            {/* ---- Lock controls (shared by the member list below) ---- */}
            <div className="list" style={{ marginBottom: 12 }}>
              <label className="field"><span>Provider</span>
                <select value={lockProvider} onChange={(e) => setLockProvider(e.target.value as LLMProvider)}>
                  <option value="none">None (force on-device rules)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="adacode">adaCode</option>
                </select>
              </label>
              {lockProvider !== 'none' && (
                <>
                  <label className="field"><span>API key (never displayed back to the target user)</span>
                    <input type="password" value={lockKey} onChange={(e) => setLockKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
                  </label>
                  <label className="field"><span>Model override (optional)</span>
                    <input value={lockModel} onChange={(e) => setLockModel(e.target.value)} placeholder="leave blank for the provider default (adacode-3.0-flash)" />
                  </label>
                </>
              )}
            </div>

            {/* ---- Member directory ---- */}
            <div className="list">
              <div className="row" style={{ fontWeight: 600 }}>
                <span className="grow">Registered users</span>
                <span className="muted small">{members.length}</span>
              </div>
              {members.map((m) => {
                const pol = policies[m.user_id];
                const isThisAdmin = adminIds.includes(m.user_id);
                const isSelf = m.user_id === myUserId;
                return (
                  <div key={m.user_id} className="row" style={{ flexWrap: 'wrap', columnGap: 8 }}>
                    <div className="grow">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{m.display_name || m.email}</span>
                        {isThisAdmin && <span className="badge">admin</span>}
                        {isSelf && <span className="badge">you</span>}
                        {pol && pol.provider !== 'none' && (
                          <span className="badge" style={{ background: 'var(--warn, #b8860b)', color: '#fff' }}>{pol.provider}</span>
                        )}
                      </div>
                      <div className="muted small">
                        {m.email}
                        {pol && pol.provider !== 'none' && (
                          <> · {pol.model ? pol.model + ' · ' : ''}key …{pol.key_finger}</>
                        )}
                        {pol?.provider === 'none' && ' · locked to on-device rules'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn sm"
                        disabled={lockBusy || (lockProvider !== 'none' && !lockKey.trim())}
                        onClick={() => void setLockFor(m, lockProvider)}
                      >
                        {lockBusy ? 'Saving…' : 'Apply'}
                      </button>
                      <button className="btn ghost sm" onClick={() => void unlockUser(m)}>Clear</button>
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
