// ============================================================================
// AccountGate — multi-user account picker (Supabase email auth).
//
// Shown when a cloud DB is configured and no account is signed in. Data lives
// ONLY in the database (one encrypted vault row per user, RLS-scoped to
// auth.uid()). The account password doubles as the vault key: on first run
// the vault is auto-created under it, on later sign-ins it auto-unlocks.
// There is no second passphrase — one credential, end to end.
// ============================================================================

import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../auth/AuthProvider';
import { IShield, IUser } from '../icons';

type Mode = 'signin' | 'signup';

export function AccountGate() {
  const auth = useAuthStore();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'signup') {
        await auth.signUp(email, password, name || email.split('@')[0]);
        // If a session was returned we land on the vault gate automatically.
      } else {
        await auth.signIn(email, password);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  // Surface "email confirmation pending" from the sign-up path.
  const notice = mode === 'signup' && auth.lastError?.startsWith('Account created') ? auth.lastError : null;

  return (
    <div className="gate">
      <div className="panel">
        <div className="emblem"><IUser size={40} /></div>
        <h1>{mode === 'signin' ? 'Sign in to OmniFlow' : 'Create an account'}</h1>
        <p>
          Each account syncs its own <em>encrypted</em> vault across devices.
          Your password doubles as the vault key: data is decrypted only on-device,
          and the cloud stores ciphertext. No plaintext ever reaches the server.
        </p>

        {notice && (
          <div className="notice">{notice}</div>
        )}

        <form onSubmit={submit} noValidate>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              required
              autoComplete="email"
            />
          </label>

          {mode === 'signup' && (
            <label className="field">
              <span>Display name (optional)</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </label>
          )}

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </label>

          <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy} type="submit">
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="err">{err ?? ''}</div>

        <button
          className="btn ghost sm"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => {
            setErr(null);
            setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
          }}
        >
          {mode === 'signin' ? 'New here? Create an account' : 'Already have one? Sign in'}
        </button>

        <p className="muted small" style={{ marginTop: 12 }}>
          <IShield size={13} /> Data is encrypted in your browser before it is
          saved; the database only ever holds AES-GCM ciphertext. Your
          password never leaves this device.
        </p>
      </div>
    </div>
  );
}
