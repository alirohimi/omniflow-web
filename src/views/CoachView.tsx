// ============================================================================
// Coach — conversational financial advisor (chat).
//
// Multi-session: chat history is split into named threads persisted
// encrypted inside the vault. The user can switch, rename, and delete
// threads (armed destructive). Selecting a thread re-points the chat and
// feeds that thread's history into coachAsk.
//
// Grounded in the user's real encrypted data via useLiveData; answers come
// from the 3-tier coach engine (BYOK LLM -> deterministic rule engine).
// Bubble chat: per-thread continuity, collapsible "Quick starts" replacing
// the old blocking suggestion menu, image attach + action confirm card kept.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { coachAsk, applyAction as applyAiAction, type Action, type ActionStore } from '../ai';
import type { CoachContext } from '../ai/coach';
import type { CoachThread } from '../domain/types';
import { ICoach, IClose, IImage, IPlus, IChevron, IPencil, IX, ICheck } from '../icons';
import Markdown from '../components/Markdown';
import { useToast } from '../components/Toast';
import { compressImageToDataUrl } from '../lib/image';

const QUICK_STARTS = [
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

/** Verb-aware confirm-card copy for any of the 5 action types. */
function actionTitle(a: Action): string {
  switch (a.action) {
    case 'create_portfolio': return 'Create portfolio';
    case 'add_expense': return 'Log expense';
    case 'edit_expense': return 'Edit expense';
    case 'delete_expense': return 'Delete expense';
    case 'holding_patch': return 'Adjust holding';
  }
}

function actionDetail(a: Action): string {
  switch (a.action) {
    case 'create_portfolio':
      return `${a.platformName} (${a.accountType}) · ${a.holdings.length} holding${a.holdings.length === 1 ? '' : 's'}`;
    case 'add_expense':
      return `${a.merchant} · ${a.category} · ${a.amount.toLocaleString()} ${a.currency} · via ${a.paymentMethod}`;
    case 'edit_expense':
      return `expense ${a.targetId} · changing ${Object.keys(a.patches).join(', ')}`;
    case 'delete_expense':
      return `expense ${a.targetId}`;
    case 'holding_patch':
      return `holding ${a.targetId} · changing ${Object.keys(a.patches).join(', ')}`;
  }
}

/** Relative "last updated" label for a thread row. */
function relTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// ThreadSwitcher — custom-themed panel (NO native <select>).
// Mobile: bottom sheet. Wide: dropdown card. Rows >=44px. Armed delete.
// ---------------------------------------------------------------------------

interface ThreadSwitcherProps {
  threads: CoachThread[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}

function ThreadSwitcher({
  threads, activeId, onSelect, onNew, onRename, onDelete, onClose, toast,
}: ThreadSwitcherProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armDelete = (id: string) => {
    if (armedDelete === id) {
      deleteCoachThreadSafe(id);
      setArmedDelete(null);
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      return;
    }
    setArmedDelete(id);
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    deleteTimer.current = setTimeout(() => setArmedDelete(null), 3000);
  };

  const deleteCoachThreadSafe = (id: string) => {
    const wasActive = id === activeId;
    onDelete(id);
    toast(wasActive ? 'Thread deleted. Switched to another chat.' : 'Thread deleted.', 'ok');
  };

  useEffect(() => () => { if (deleteTimer.current) clearTimeout(deleteTimer.current); }, []);

  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 900,
          background: 'rgba(0,0,0,0.3)',
        }}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 901,
          background: 'var(--surface, #1a1a2e)',
          borderTop: '1px solid var(--border, #333)',
          borderRadius: '16px 16px 0 0',
          padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
          maxHeight: '70vh',
          display: 'flex', flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>Chats</strong>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close"><IClose size={16} /></button>
        </div>

        {/* Thread list */}
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: '50vh' }}>
          {sorted.map((t) => {
            const isActive = t.id === activeId;
            const isArmed = armedDelete === t.id;
            const isRenaming = renaming === t.id;
            return (
              <div
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  minHeight: 44, padding: '6px 8px',
                  borderRadius: 10,
                  background: isActive ? 'var(--accent-bg, rgba(59,130,246,0.12))' : 'transparent',
                  borderLeft: isActive ? '3px solid var(--accent, #3b82f6)' : '3px solid transparent',
                  marginBottom: 2,
                }}
              >
                {/* Row content */}
                <div
                  style={{ flex: 1, cursor: 'pointer', minHeight: 32, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
                  onClick={() => { if (!isRenaming) { onSelect(t.id); onClose(); } }}
                >
                  {isRenaming ? (
                    <input
                      value={renameText}
                      maxLength={80}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renameText.trim()) {
                          onRename(t.id, renameText.trim());
                          setRenaming(null);
                          toast(
                            renameText.length >= 80
                              ? 'Renamed (title capped at 80 characters).'
                              : 'Renamed.',
                            'ok',
                          );
                        }
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      style={{
                        width: '100%', background: 'transparent',
                        border: '1px solid var(--accent, #3b82f6)',
                        borderRadius: 6, padding: '4px 8px',
                        color: 'var(--text, #fff)', fontSize: 14,
                      }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.title || 'New chat'}
                      </span>
                      {isActive && <ICheck size={12} />}
                    </div>
                  )}
                  {!isRenaming && (
                    <span className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {relTime(t.updatedAt)} · {t.messages.length} msg
                    </span>
                  )}
                </div>

                {/* Row actions — 44px min hit targets (P2-1). */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    className="btn ghost sm"
                    style={{ minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={(e) => { e.stopPropagation(); setRenaming(t.id); setRenameText(t.title); }}
                    aria-label="Rename"
                  >
                    <IPencil size={14} />
                  </button>
                  <button
                    className={`btn sm ${isArmed ? 'danger' : 'ghost'}`}
                    style={{ minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: isArmed ? 11 : 14, gap: 4 }}
                    onClick={(e) => { e.stopPropagation(); armDelete(t.id); }}
                    aria-label="Delete thread"
                  >
                    {isArmed ? 'Confirm' : <IX size={14} />}
                  </button>
                </div>
              </div>
            );
          })}
          {sorted.length === 0 && (
            <p className="muted" style={{ padding: 16, textAlign: 'center' }}>No chats yet</p>
          )}
        </div>

        {/* Footer: New chat */}
        <button
          className="btn sm"
          style={{ marginTop: 12, minHeight: 44, width: '100%' }}
          onClick={() => { onNew(); onClose(); }}
        >
          <IPlus size={14} /> New chat
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main CoachView
// ---------------------------------------------------------------------------

export function CoachView() {
  const store = useVaultStore();
  const live = useLiveData();
  const { toast } = useToast();
  const { vault, coachMessages, activeCoachThread, coachThreads } = store;

  const [draft, setDraft] = useState('');
  const [attach, setAttach] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [quickStartsOpen, setQuickStartsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const hasLLM = store.llmConfig != null;
  const llmAllowed = store.entitlements.has('llm-coach');
  const adminLocked =
    !store.isAdminUser && !!store.llmPolicy && store.llmPolicy.provider !== 'none';

  // Grounded context for the coach engine.
  const ctx: CoachContext | null = useMemo(() => {
    if (!vault) return null;
    return {
      expenses: vault.expenses,
      accounts: vault.accounts,
      holdings: vault.holdings,
      quotes: live.quotes,
      prefs: vault.prefs,
      portfolio: live.portfolio,
      categories: store.categories,
      emergency: vault.emergency,
      fx: live.fx,
    };
  }, [vault, live.quotes, live.portfolio, live.fx, store.categories]);

  // Scroll to bottom when the active thread's messages grow or we switch thread.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [coachMessages.length, activeCoachThread, pending]);

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
    if ((!q && !img) || !ctx || pending || !activeCoachThread) return;
    setDraft('');
    setAttach(null);
    setPendingAction(null);
    store.pushCoachMessageTo(activeCoachThread, { role: 'user', text: q, image: img ?? undefined, at: Date.now() });
    setPending(true);
    try {
      const activeLlm = llmAllowed ? store.llmConfig : null;
      const ans = await coachAsk(
        q,
        ctx,
        activeLlm,
        coachMessages,
        img ? [img] : [],
      );
      store.pushCoachMessageTo(activeCoachThread, {
        role: 'coach',
        text: ans.text,
        source: ans.source,
        at: Date.now(),
      });
      if (ans.proposedAction) setPendingAction(ans.proposedAction);
      if (ans.degraded) {
        const why = ans.llmError ? ` (${ans.llmError.slice(0, 140)})` : '';
        toast(`Advisor key call failed${why} — answered with the on-device rule engine. Fix it in Settings.`, 'err');
      }
    } catch (e) {
      store.pushCoachMessageTo(activeCoachThread, {
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
      const actionStore: import('../ai').ActionStore = {
        addAccount: store.addAccount,
        addHolding: store.addHolding,
        getAccounts: () => store.vault?.accounts ?? [],
        getHoldings: () => store.vault?.holdings ?? [],
        addExpense: store.addExpense,
        editExpense: store.editExpense,
        deleteExpense: store.deleteExpense,
        getExpenses: () => store.vault?.expenses ?? [],
        getCategories: () => store.vault?.categories ?? [],
        updateHolding: store.updateHolding,
      };
      const summary = applyAiAction(actionStore, a, live.fx ?? undefined);
      store.pushCoachMessageTo(activeCoachThread, {
        role: 'coach',
        text: `Done — ${summary}. It is live in your data; quotes fill in automatically.`,
        source: 'system',
        at: Date.now(),
      });
      toast('Action applied.', 'ok');
    } catch (e) {
      toast(`Could not apply the action: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  };

  const dismissAction = () => {
    if (!pendingAction) return;
    store.pushCoachMessageTo(activeCoachThread, {
      role: 'coach',
      text: 'Understood — nothing was created. Tell me what to change and I will re-propose it.',
      source: 'system',
      at: Date.now(),
    });
    setPendingAction(null);
  };

  if (!vault) return null;

  const hasMessages = coachMessages.length > 0;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="chip ok sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ICoach size={13} /> Coach
          </span>
          <span className={`chip sm ${hasLLM && llmAllowed ? 'ok' : ''}`}>
            {hasLLM && llmAllowed
              ? adminLocked
                ? 'LIVE · Managed'
                : `LIVE · ${store.llmConfig!.provider}`
              : hasLLM && !llmAllowed
                ? 'LLM requires Pro — using on-device rules'
                : 'ON-DEVICE RULES (free)'}
          </span>
        </div>
        <div className="row" style={{ gap: 4 }}>
          {/* Thread switcher trigger */}
          <button
            className="btn ghost sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 44, minHeight: 44 }}
            onClick={() => setSwitcherOpen(true)}
            aria-label="Switch chat"
            >
            <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}><IChevron size={13} /></span>
            Chats
            </button>
        </div>
      </div>

      <div className="coach-chat" ref={scrollRef}>
        {/* Quick starts accordion — shown only when the active thread is empty */}
        {!hasMessages && (
          <div className="coach-welcome">
            <div className="coach-welcome-ico"><ICoach size={22} /></div>
            <h3>Ask me about your money</h3>
            <p>
              I reason over your real numbers — net worth, allocation, spend
              pace, currency exposure. No key configured? I answer with the
              on-device rule engine, so it stays free and offline.
            </p>
            {/* Collapsible quick starts */}
            <div style={{ marginTop: 8 }}>
              <button
                className="btn ghost sm"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44 }}
                onClick={() => setQuickStartsOpen(!quickStartsOpen)}
              >
                <span style={{ display: 'inline-flex', transform: quickStartsOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}>
                  <IChevron size={12} />
                </span>
                Quick starts
              </button>
              {quickStartsOpen && (
                <div className="coach-chips" style={{ marginTop: 8 }}>
                  {QUICK_STARTS.map((s) => (
                    <button key={s} className="chip" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {coachMessages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-body">
              {m.image ? <img className="coach-msg-img" src={m.image} alt="Attached" /> : null}
              {m.text ? (
                <div className="bubble">
                  {m.role === 'coach' ? <Markdown text={m.text} className="md" /> : m.text}
                </div>
              ) : null}
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
            <strong style={{ fontSize: 13 }}>{actionTitle(pendingAction)}</strong>
            <span className="muted small">not applied yet</span>
          </div>
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            {actionDetail(pendingAction)}
          </p>
          {pendingAction.action === 'create_portfolio' ? (
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
          ) : null}
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

      {switcherOpen && (
        <ThreadSwitcher
          threads={coachThreads}
          activeId={activeCoachThread}
          onSelect={(id) => store.setActiveCoachThread(id)}
          onNew={() => store.addCoachThread()}
          onRename={(id, title) => store.renameCoachThread(id, title)}
          onDelete={(id) => store.deleteCoachThread(id)}
          onClose={() => setSwitcherOpen(false)}
          toast={toast}
        />
      )}
    </>
  );
}
