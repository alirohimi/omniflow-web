// ============================================================================
// VaultGate — the app's zero-trust front door.
//
// Single credential: the account password is the vault key.
//   - First run / returning user who just signed in: auto-creates or auto-
//     unlocks in-memory (no screen shown).
//   - Page refresh / manual lock: shows this one-field screen.
//   - DB unreachable: shows a retry screen.
// ============================================================================

import { useState } from 'react';
import { useVaultStore } from '../store/store';
import { IShield, ILock } from '../icons';

export function VaultGate({ onReady }: { onReady: () => void }) {
  const { status, error, unlock } = useVaultStore();
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

  // 'creating' here means the auto-create path is in flight. In practice this
  // is a transient state (the effect fires unlock/createVault immediately),
  // so we just show a brief loading panel.
  if (status === 'creating') {
    return (
      <div className="gate">
        <div className="panel" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
            <span className="spinner" />
          </div>
          <h1>Setting up your vault…</h1>
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
