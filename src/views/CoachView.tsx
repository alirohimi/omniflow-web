// ============================================================================
// Coach — conversational financial advisor (chat).
//
// Grounded in the user's real encrypted data via useLiveData; answers come
// from the 3-tier coach engine (BYOK LLM -> deterministic rule engine).
// Chat history persists encrypted with the vault. Suggestion chips open the
// conversation with data-grounded questions instead of a blank box.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { coachAsk, applyCreatePortfolio, type CreatePortfolioAction } from '../ai';
import type { CoachContext } from '../ai/coach';
import { ICoach, IClose, IImage } from '../icons';
import { useToast } from '../components/Toast';
import { compressImageToDataUrl } from '../lib/image';

const SUGGESTIONS = [
  'Where should I put new money?',
  'How is my portfolio allocated?',
  'Am I overspending?',
  'What is my currency exposure?',
  'If the market crashed, what survives?',
];

const BADGE: Record<string, string> = {
  llm: 'AI advisor',
  rules: 'Rule engine',
  system: 'Rule engine',
};

export function CoachView() {
  const store = useVaultStore();
  const live = useLiveData();
  const { toast } = useToast();
  const { vault, coachLog } = store;
  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<CreatePortfolioAction | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const hasLLM = store.llmConfig != null;

  // The grounded context the engine reasons over. Rebuilt when the data
  // moves; the LLM prompt only ever receives the compact brief derived
  // from this (never the raw ledger).
  const ctx: CoachContext | null = useMemo(() => {
    if (!vault) return null;
    return {
      expenses: vault.expenses,
      accounts: vault.accounts,
      holdings: vault.holdings,
      quotes: live.quotes,
      prefs: vault.prefs,
      portfolio: live.portfolio,
    };
  }, [vault, live.quotes, live.portfolio]);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [coachLog.length, pending]);

  const pickImage = async (f: File | null) => {
    if (!f) return;
    const url = await compressImageToDataUrl(f);
    if (!url) {
      toast('Could not read that image — try a JPEG or PNG screenshot.', 'err');
      return;
    }
    setAttach(url);
  };

  const send = async (text: string, image?: string) => {
    const q = text.trim();
    const img = image ?? attach;
    if ((!q && !img) || !ctx || pending) return;
    setDraft('');
    setAttach(null);
    setPendingAction(null);
    store.pushCoachMessage({ role: 'user', text: q, image: img ?? undefined, at: Date.now() });
    setPending(true);
    try {
      const ans = await coachAsk(
        q,
        ctx,
        store.llmConfig,
        coachLog,
        img ? [img] : [],
      );
      store.pushCoachMessage({
        role: 'coach',
        text: ans.text,
        source: ans.source,
        at: Date.now(),
      });
      // If the LLM proposed a create_portfolio action, hold it for explicit
      // user confirmation (Apply). Nothing is written to the vault until then.
      if (ans.proposedAction) setPendingAction(ans.proposedAction);
      if (ans.degraded) {
        const why = ans.llmError ? ` (${ans.llmError.slice(0, 140)})` : '';
        toast(`Advisor key call failed${why} — answered with the on-device rule engine. Fix it in Settings (Test key shows the provider's exact error).`, 'err');
      }
    } catch (e) {
      store.pushCoachMessage({
        role: 'coach',
        text: `I could not produce an answer just now (${e instanceof Error ? e.message : 'unknown error'}). Try again in a moment.`,
        source: 'system',
        at: Date.now(),
      });
    } finally {
      setPending(false);
    }
  };

  const applyAction = () => {
    if (!pendingAction) return;
    const a = pendingAction;
    setPendingAction(null);
    try {
      const summary = applyCreatePortfolio(store, a);
      store.pushCoachMessage({
        role: 'coach',
        text: `Done — ${summary}. It is live in the Portfolio tab; quotes fill in automatically.`,
        source: 'system',
        at: Date.now(),
      });
      toast('Portfolio created.');
    } catch (e) {
      toast(`Could not apply the portfolio: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  };

  const dismissAction = () => {
    if (!pendingAction) return;
    store.pushCoachMessage({
      role: 'coach',
      text: 'Understood — nothing was created. Tell me what to change and I will re-propose it.',
      source: 'system',
      at: Date.now(),
    });
    setPendingAction(null);
  };

  if (!vault) return null;

  const hasMessages = coachLog.length > 0;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="chip ok sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ICoach size={13} /> Coach
          </span>
          <span className={`chip sm ${hasLLM ? 'ok' : ''}`}>
            {hasLLM ? `LIVE · ${store.llmConfig!.provider}` : 'ON-DEVICE RULES (free)'}
          </span>
        </div>
        {hasMessages && (
          <button
            className="btn ghost sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => {
              store.clearCoachLog();
              toast('Conversation cleared.');
            }}
          >
            <IClose size={13} /> Clear
          </button>
        )}
      </div>

      <div className="coach-chat" ref={scrollRef}>
        {!hasMessages && (
          <div className="coach-welcome">
            <div className="coach-welcome-ico"><ICoach size={22} /></div>
            <h3>Ask me about your money</h3>
            <p>
              I reason over your real numbers — net worth, allocation, spend
              pace, currency exposure. No key configured? I answer with the
              on-device rule engine, so it stays free and offline.
            </p>
            <div className="coach-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {coachLog.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-body">
              {m.image ? <img className="coach-msg-img" src={m.image} alt="Attached" /> : null}
              {m.text ? <div className="bubble">{m.text}</div> : null}
              <div className="msg-meta">
                {m.role === 'coach' && m.source ? (
                  <span>{BADGE[m.source] ?? m.source}</span>
                ) : null}
                <span>
                  {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
        ))}

        {pending && (
          <div className="msg coach">
            <div className="msg-body">
              <div className="bubble thinking">Thinking…</div>
            </div>
          </div>
        )}
      </div>

      {pendingAction && (
        <div className="card" style={{ marginTop: 10, border: '1px solid var(--accent, #3b82f6)' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Create portfolio</strong>
            <span className="muted small">not applied yet</span>
          </div>
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            {pendingAction.platformName} ({pendingAction.accountType}) · {pendingAction.holdings.length} holding
            {pendingAction.holdings.length === 1 ? '' : 's'}
          </p>
          <div className="coach-action-list">
            {pendingAction.holdings.map((h) => (
              <div key={h.symbol} className="row" style={{ justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{h.symbol}</span>
                <span className="muted small">
                  {h.units.toLocaleString()} @ {h.entryPrice > 0 ? h.entryPrice.toLocaleString() : 'n/a'} {h.currency}
                </span>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn sm" onClick={applyAction}>
              Apply to my portfolio
            </button>
            <button className="btn ghost sm" onClick={dismissAction}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <form
        className="coach-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {attach && (
          <div className="coach-attach-strip">
            <img className="coach-attach-thumb" src={attach} alt="Attachment preview" />
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Remove attachment"
              onClick={() => setAttach(null)}
            >
              <IClose size={14} />
            </button>
          </div>
        )}
        <div className="coach-composer-row">
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Attach image"
            title="Attach an image (receipt, screenshot)"
            onClick={() => fileRef.current?.click()}
            disabled={pending}
          >
            <IImage size={16} />
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void pickImage(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your portfolio, spend, or exposure…"
            aria-label="Ask the coach"
            disabled={pending}
          />
          <button className="btn sm" type="submit" disabled={pending || (!draft.trim() && !attach)}>
            Send
          </button>
        </div>
      </form>
    </>
  );
}
