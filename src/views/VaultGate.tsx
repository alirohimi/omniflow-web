// ============================================================================
// VaultGate — the app's zero-trust front door.
//
// Single credential: the account password is the vault key.
//   - First run / returning user who just signed in: auto-creates or auto-
//     unlocks in-memory (no screen shown).
//   - Page refresh / manual lock: shows the one-field unlock screen.
//   - No vault row under the account yet (fresh account, or the data was
//     just erased on a session without the key in memory): shows the
//     "Set up your vault" screen — without this the user would spin forever.
//   - DB unreachable: shows a retry screen.
// ============================================================================

import { useState } from 'react';
import { useVaultStore } from '../store/store';
import { IShield, ILock } from '../icons';

export function VaultGate({ onReady }: { onReady: () => void }) {
  const { status, error, unlock, createVault } = useVaultStore();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  // DB unreachable (network / PostgREST down) — show retry, never wipe.
  if (status === 'unavailable') {
    return (
      <div className="gate">
        <div className="panel">
          <div className="emblem"><ILock size={40} /></div>
          <h1>Locked out</h1>
          <p>{error ?? 'Could not reach your data store. Your encrypted data is intact — retry when the network is back.'}</p>
          <button className="btn ghost sm" onClick={() => location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  // Auto-unlock / auto-create already ran (or will run): the app renders.
  if (status === 'unlocked') return null;

  // 'creating': no vault row under this account yet — either a brand-new
  // account or the data was just erased (Settings → Danger zone) on a
  // session that no longer holds the key in memory (after a refresh the
  // auto-create effect cannot fire, so this screen is the recovery path:
  // pick a password and a fresh encrypted vault is created and synced).
  if (status === 'creating') {
    const submit = async () => {
      setLocalErr(null);
      setBusy(true);
      try {
        await createVault(pass);
        onReady();
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="gate">
        <div className="panel">
          <div className="emblem"><IShield size={40} /></div>
          <h1>Set up your vault</h1>
          <p>
            This account has no data yet, or it was just erased. Pick a
            password to create a fresh encrypted vault — you will use it to
            unlock on every new session.
          </p>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="min 4 characters"
              autoFocus
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>
          <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy || pass.length < 4} onClick={submit}>
            {busy ? 'Creating…' : 'Create vault'}
          </button>
          <div className="err">{localErr ?? error ?? ''}</div>
          <p className="muted small" style={{ marginTop: 14 }}>
            <IShield size={13} /> Data is decrypted only in your browser. The
            database never sees plaintext.
          </p>
        </div>
      </div>
    );
  }

  // 'locked': the user has a session but no in-memory key (refresh / lock).
  const submit = async () => {
    setLocalErr(null);
    setBusy(true);
    try {
      await unlock(pass);
      onReady();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="panel">
        <div className="emblem"><IShield size={40} /></div>
        <h1>Unlock OmniFlow</h1>
        <p>
          Enter your password to decrypt your data locally.
          Your data stays encrypted at rest; the cloud only holds ciphertext.
        </p>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="••••••••"
            autoFocus
            autoComplete="current-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>

        <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy || !pass} onClick={submit}>
          {busy ? 'Decrypting…' : 'Unlock'}
        </button>

        <div className="err">{localErr ?? error ?? ''}</div>

        <p className="muted small" style={{ marginTop: 14 }}>
          <IShield size={13} /> Data is decrypted only in your browser. The
          database never sees plaintext.
        </p>
      </div>
    </div>
  );
}
