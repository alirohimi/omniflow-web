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
import { coachAsk } from '../ai';
import type { CoachContext } from '../ai/coach';
import { ICoach, IClose } from '../icons';
import { useToast } from '../components/Toast';

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
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || !ctx || pending) return;
    setDraft('');
    store.pushCoachMessage({ role: 'user', text: q, at: Date.now() });
    setPending(true);
    try {
      const ans = await coachAsk(
        q,
        ctx,
        store.llmConfig,
        coachLog,
      );
      store.pushCoachMessage({
        role: 'coach',
        text: ans.text,
        source: ans.source,
        at: Date.now(),
      });
      if (ans.degraded) {
        toast('Advisor key call failed — answered with the on-device rule engine.', 'err');
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
              <div className="bubble">{m.text}</div>
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

      <form
        className="coach-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about your portfolio, spend, or exposure…"
          aria-label="Ask the coach"
          disabled={pending}
        />
        <button className="btn sm" type="submit" disabled={pending || !draft.trim()}>
          Send
        </button>
      </form>
    </>
  );
}
