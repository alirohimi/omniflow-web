// ============================================================================
// VaultGate — the app's zero-trust front door.
//
// First launch: create a passphrase vault (AES-GCM in IndexedDB).
// Returning: unlock with the passphrase. A wrong passphrase always fails
// decrypt (authenticated crypto), never a partial read.
// ============================================================================

import { useState } from 'react';
import { useVaultStore } from '../store/store';
import { currencyInfo, CURRENCIES } from '../domain/enums';
import { IShield, ILock } from '../icons';

export function VaultGate({ onReady }: { onReady: () => void }) {
  const { status, error, createVault, unlock } = useVaultStore();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [base, setBase] = useState('MYR');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  if (status === 'unavailable') {
    return (
      <div className="gate">
        <div className="panel">
          <div className="emblem"><ILock size={40} /></div>
          <h1>Locked out</h1>
          <p>{error ?? 'The existing vault could not be read. Your encrypted data is intact — try again, or erase it to start fresh.'}</p>
          <button className="btn ghost sm" onClick={() => location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  if (status === 'unlocked') return null; // App renders instead.

  // 'creating' = first launch (no vault on device yet); 'locked' = vault
  // exists and needs the passphrase.
  const isCreating = status === 'creating';

  const submit = async () => {
    setLocalErr(null);
    setBusy(true);
    try {
      if (isCreating) {
        if (pass.length < 4) throw new Error('Passphrase must be at least 4 characters.');
        if (pass !== pass2) throw new Error('Passphrases do not match.');
        await createVault(pass, { baseCurrency: base });
      } else {
        await unlock(pass);
      }
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
        <h1>{isCreating ? 'Create your vault' : 'Unlock OmniFlow'}</h1>
        <p>
          {isCreating
            ? 'All your data is encrypted in this browser with a key derived from your passphrase. No server, no account, $0.'
            : 'Enter your passphrase to decrypt your data locally.'}
        </p>

        {isCreating && (
          <label className="field">
            <span>Base currency (for totals)</span>
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name} ({currencyInfo(c.code).symbol})
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>Passphrase</span>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="••••••••"
            // No autoFocus on touch: the on-screen keyboard covers the whole
            // panel on phones. Desktop users can just click / Tab into it.
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>

        {isCreating && (
          <label className="field">
            <span>Confirm passphrase</span>
            <input
              type="password"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              placeholder="••••••••"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>
        )}

        <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={submit}>
          {busy ? 'Working…' : isCreating ? 'Create encrypted vault' : 'Unlock'}
        </button>

        <div className="err">{localErr ?? error ?? ''}</div>
        {isCreating && (
          <p className="muted small" style={{ marginTop: 14 }}>
            Tip: after setup, add an LLM key (OpenAI/Anthropic) in Settings for Tier-1 categorization. Without one, OmniFlow falls back to on-device rules.
          </p>
        )}
      </div>
    </div>
  );
}
