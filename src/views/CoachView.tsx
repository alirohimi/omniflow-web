// ============================================================================
// Coach — Gemini-style conversational financial advisor.
//
// Desktop: collapsible persistent thread sidebar + centered editorial chat
// canvas + floating multi-line prompt composer with upward strategy picker.
// Mobile (<900px): slide-over thread drawer + full-height chat + HIG targets.
// Grounded in the user's real encrypted vault via useLiveData (BYOK LLM or
// $0 on-device rule engine fallback).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { coachAsk, applyAction as applyAiAction, type Action } from '../ai';
import { FAMED_STRATEGIES } from '../domain/enums';
import type { CoachContext } from '../ai/coach';
import type { CoachThread } from '../domain/types';
import {
  IArrowUp,
  ICheck,
  IClose,
  ICopy,
  IImage,
  IPencil,
  IPlus,
  ISidebar,
  ISparkle,
  IX,
} from '../icons';
import Markdown from '../components/Markdown';
import { useToast } from '../components/Toast';
import { compressImageToDataUrl } from '../lib/image';

const SUGGESTIONS: { title: string; prompt: string; tag: string }[] = [
  {
    title: 'Deploy new capital',
    prompt: 'Where should I put new money?',
    tag: 'Allocation',
  },
  {
    title: 'Portfolio health check',
    prompt: 'How is my portfolio allocated?',
    tag: 'Portfolio',
  },
  {
    title: 'Monthly spend audit',
    prompt: 'Am I overspending?',
    tag: 'Budget',
  },
  {
    title: 'Currency & FX exposure',
    prompt: 'What is my currency exposure?',
    tag: 'FX Risk',
  },
];

const EXTRA_PROMPT = 'If the market crashed, what survives?';

const BADGE: Record<string, string> = {
  llm: 'AI Advisor',
  rules: 'On-Device Rules',
  system: 'System',
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
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// ThreadSidebar — Gemini-style Recent threads panel (persistent on desktop,
// slide-over drawer on mobile). Preserves inline rename + 2-tap armed delete.
// ---------------------------------------------------------------------------

interface ThreadSidebarProps {
  open: boolean;
  threads: CoachThread[];
  activeId: string;
  engineLabel: string;
  engineLive: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onCloseMobile: () => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}

function ThreadSidebar({
  open,
  threads,
  activeId,
  engineLabel,
  engineLive,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onCloseMobile,
  toast,
}: ThreadSidebarProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
  }, []);

  const armDelete = (id: string) => {
    if (armedDelete === id) {
      const wasActive = id === activeId;
      onDelete(id);
      toast(wasActive ? 'Thread deleted. Switched to another chat.' : 'Thread deleted.', 'ok');
      setArmedDelete(null);
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      return;
    }
    setArmedDelete(id);
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    deleteTimer.current = setTimeout(() => setArmedDelete(null), 3000);
  };

  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      {open && (
        <div
          className="gem-backdrop"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}
      <aside className={`gem-sidebar${open ? ' open' : ''}`} aria-label="Chat history">
        <div className="gem-sidebar-top">
          <button
            type="button"
            className="gem-new-btn"
            onClick={() => {
              onNew();
              onCloseMobile();
            }}
          >
            <IPlus size={16} />
            <span>New chat</span>
          </button>
          <button
            type="button"
            className="gem-icon-btn gem-mobile-only"
            aria-label="Close sidebar"
            onClick={onCloseMobile}
          >
            <IClose size={16} />
          </button>
        </div>

        <div className="gem-sidebar-lbl">Recent</div>

        <div className="gem-thread-list">
          {sorted.map((t) => {
            const isActive = t.id === activeId;
            const isArmed = armedDelete === t.id;
            const isRenaming = renaming === t.id;
            return (
              <div
                key={t.id}
                className={`gem-thread${isActive ? ' active' : ''}`}
              >
                <div
                  className="gem-thread-main"
                  onClick={() => {
                    if (!isRenaming) {
                      onSelect(t.id);
                      onCloseMobile();
                    }
                  }}
                >
                  {isRenaming ? (
                    <input
                      value={renameText}
                      maxLength={80}
                      className="gem-rename-input"
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
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="gem-thread-title">{t.title || 'New chat'}</span>
                      <span className="gem-thread-sub">
                        {relTime(t.updatedAt)} · {t.messages.length} msg
                      </span>
                    </>
                  )}
                </div>

                {!isRenaming && (
                  <div className="gem-thread-acts">
                    <button
                      type="button"
                      className="gem-thread-act"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenaming(t.id);
                        setRenameText(t.title);
                      }}
                      aria-label="Rename"
                      title="Rename chat"
                    >
                      <IPencil size={13} />
                    </button>
                    <button
                      type="button"
                      className={`gem-thread-act${isArmed ? ' armed' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        armDelete(t.id);
                      }}
                      aria-label="Delete thread"
                      title={isArmed ? 'Click again to delete' : 'Delete chat'}
                    >
                      {isArmed ? 'Confirm' : <IX size={13} />}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {sorted.length === 0 && (
            <p className="muted small" style={{ padding: '14px 10px', margin: 0 }}>No chats yet</p>
          )}
        </div>

        <div className="gem-sidebar-foot">
          <span className={`gem-engine-dot${engineLive ? ' live' : ''}`} aria-hidden="true" />
          <span className="gem-engine-txt">{engineLabel}</span>
        </div>
      </aside>
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
  const pending = store.coachPendingThreads.includes(activeCoachThread);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 900 : true,
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const strategyRef = useRef<HTMLDivElement | null>(null);

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

  // Scroll feed to bottom on new messages / thread switch / pending state.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [coachMessages.length, activeCoachThread, pending]);

  // Auto-grow textarea cleanly up to 160px.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, Math.max(24, ta.scrollHeight))}px`;
  }, [draft]);

  const pickImage = async (f: File | null) => {
    if (!f) return;
    const url = await compressImageToDataUrl(f);
    if (!url) {
      toast('Could not read that image — try a JPEG or PNG screenshot.', 'err');
      return;
    }
    setAttach(url);
  };

  // Thinking mode (coachThinking pref, default ON).
  const coachThinking = store.vault?.prefs.coachThinking ?? true;
  const toggleThinking = () => {
    store.setPrefs({ coachThinking: !coachThinking });
  };

  // Portfolio strategy picker (FAMED_STRATEGIES).
  const coachStrategy = store.vault?.prefs.coachStrategy ?? '60-40';
  const [strategyOpen, setStrategyOpen] = useState(false);
  const setStrategy = (key: string) => {
    store.setPrefs({ coachStrategy: key });
    setStrategyOpen(false);
  };
  const strategyName = FAMED_STRATEGIES[coachStrategy as keyof typeof FAMED_STRATEGIES]?.name ?? coachStrategy;

  // Close strategy popover on outside tap / Escape.
  useEffect(() => {
    if (!strategyOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (strategyRef.current && !strategyRef.current.contains(e.target as Node)) {
        setStrategyOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStrategyOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [strategyOpen]);

  const send = async (text: string, image?: string) => {
    const q = text.trim();
    const img = image ?? attach;
    if ((!q && !img) || !ctx || pending || !activeCoachThread) return;
    setDraft('');
    setAttach(null);
    setPendingAction(null);
    store.pushCoachMessageTo(activeCoachThread, { role: 'user', text: q, image: img ?? undefined, at: Date.now() });
    store.markCoachPending(activeCoachThread);
    try {
      const activeLlm = llmAllowed ? store.llmConfig : null;
      const ans = await coachAsk(
        q,
        ctx,
        activeLlm,
        coachMessages,
        img ? [img] : [],
        coachThinking,
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
      store.clearCoachPending(activeCoachThread);
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

  const copyMessage = async (id: string, text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000);
    } catch {
      toast('Clipboard unavailable', 'err');
    }
  };

  if (!vault) return null;

  const hasMessages = coachMessages.length > 0;
  const activeThread = coachThreads.find((t) => t.id === activeCoachThread);
  const rawName = (vault.prefs.displayName ?? '').trim();
  const greetingName = !rawName || rawName.toLowerCase() === 'you' ? 'there' : rawName;
  const engineLive = hasLLM && llmAllowed;
  const engineLabel = engineLive
    ? adminLocked
      ? 'OmniFlow AI · Managed'
      : `OmniFlow AI · ${store.llmConfig!.provider}`
    : hasLLM && !llmAllowed
      ? 'Pro required · On-device rules'
      : 'On-device Rules (free)';

  return (
    <div className={`gem-shell${sidebarOpen ? ' with-side' : ''}`}>
      <ThreadSidebar
        open={sidebarOpen}
        threads={coachThreads}
        activeId={activeCoachThread}
        engineLabel={engineLabel}
        engineLive={engineLive}
        onSelect={(id) => store.setActiveCoachThread(id)}
        onNew={() => store.addCoachThread()}
        onRename={(id, title) => store.renameCoachThread(id, title)}
        onDelete={(id) => store.deleteCoachThread(id)}
        onCloseMobile={() => {
          if (typeof window !== 'undefined' && window.innerWidth < 900) {
            setSidebarOpen(false);
          }
        }}
        toast={toast}
      />

      <main className="gem-main">
        {/* Top bar inside chat canvas */}
        <header className="gem-head">
          <div className="gem-head-left">
            <button
              type="button"
              className="gem-icon-btn"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label={sidebarOpen ? 'Hide chat history' : 'Show chat history'}
              title="Chats"
            >
              <ISidebar size={17} />
            </button>
            <div className="gem-brand">
              <span className="gem-brand-name">OmniFlow Coach</span>
              {activeThread?.title && activeThread.title !== 'New chat' && (
                <span className="gem-brand-thread">· {activeThread.title}</span>
              )}
            </div>
          </div>

          <div className="gem-head-right">
            <span className={`chip sm${engineLive ? ' ok' : ''}`}>
              {engineLive ? (adminLocked ? 'LIVE · Managed' : `LIVE · ${store.llmConfig!.provider}`) : 'On-Device'}
            </span>
            <button
              type="button"
              className="gem-icon-btn"
              onClick={() => store.addCoachThread()}
              aria-label="New chat"
              title="New chat"
            >
              <IPlus size={17} />
            </button>
          </div>
        </header>

        {/* Scrollable message canvas */}
        <div className="gem-scroll" ref={scrollRef}>
          <div className="gem-col">
            {!hasMessages ? (
              <div className="gem-welcome">
                <div className="gem-spark-ring" aria-hidden="true">
                  <ISparkle size={24} />
                </div>
                <h1 className="gem-hello">Hello, {greetingName}</h1>
                <p className="gem-sub">
                  How can I help with your portfolio, spending, or runway today?
                </p>

                <div className="gem-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.prompt}
                      type="button"
                      className="gem-sug-card"
                      onClick={() => void send(s.prompt)}
                    >
                      <span className="gem-sug-tag">{s.tag}</span>
                      <span className="gem-sug-title">{s.title}</span>
                      <span className="gem-sug-prompt">{s.prompt}</span>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="gem-extra-chip"
                  onClick={() => void send(EXTRA_PROMPT)}
                >
                  <ISparkle size={13} />
                  <span>{EXTRA_PROMPT}</span>
                </button>
              </div>
            ) : (
              <div className="gem-feed">
                {coachMessages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="gem-turn-user">
                      <div className="gem-user-bubble">
                        {m.image ? <img className="coach-msg-img" src={m.image} alt="Attached" /> : null}
                        {m.text ? <div>{m.text}</div> : null}
                      </div>
                      <span className="gem-turn-time">
                        {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ) : (
                    <div key={m.id} className="gem-turn-ai">
                      <div className="gem-ai-avatar" aria-hidden="true">
                        <ISparkle size={15} />
                      </div>
                      <div className="gem-ai-body">
                        {m.image ? <img className="coach-msg-img" src={m.image} alt="Attached" /> : null}
                        {m.text ? (
                          <div className="gem-ai-prose">
                            <Markdown text={m.text} className="md" />
                          </div>
                        ) : null}
                        <div className="gem-ai-foot">
                          <span>{m.source ? (BADGE[m.source] ?? m.source) : 'AI Advisor'}</span>
                          <span>·</span>
                          <span>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          {m.text && (
                            <button
                              type="button"
                              className="gem-copy-btn"
                              onClick={() => void copyMessage(m.id, m.text)}
                              aria-label="Copy response"
                            >
                              {copiedId === m.id ? <ICheck size={12} /> : <ICopy size={12} />}
                              <span>{copiedId === m.id ? 'Copied' : 'Copy'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ),
                )}

                {pending && (
                  <div className="gem-turn-ai">
                    <div className="gem-ai-avatar spin" aria-hidden="true">
                      <ISparkle size={15} />
                    </div>
                    <div className="gem-ai-body">
                      <div className="gem-thinking">
                        <span className="gem-dots" aria-hidden="true">
                          <i /><i /><i />
                        </span>
                        <span>{coachThinking ? 'Thinking over your vault…' : 'Generating…'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Pending Action Confirm Card + Floating Gemini Composer */}
        <div className="gem-bottom">
          <div className="gem-col">
            {pendingAction && (
              <div className="gem-action-card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
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
              className="gem-composer"
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

              <textarea
                ref={textareaRef}
                rows={1}
                className="gem-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder="Ask OmniFlow Coach…"
                aria-label="Ask the coach"
                disabled={pending}
              />

              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void pickImage(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />

              <div className="gem-composer-bar">
                <div className="gem-composer-tools">
                  <button
                    type="button"
                    className="gem-tool-btn"
                    aria-label="Attach image"
                    title="Attach receipt or screenshot"
                    onClick={() => fileRef.current?.click()}
                    disabled={pending}
                  >
                    <IImage size={16} />
                  </button>

                  <button
                    type="button"
                    className={`gem-tool-pill${coachThinking ? ' on' : ''}`}
                    onClick={toggleThinking}
                    aria-pressed={coachThinking}
                    title={coachThinking
                      ? 'Thinking mode ON — shows reasoning before answering'
                      : 'Fast mode — concise, answer-first replies'}
                  >
                    <span>⚡</span>
                    <span>{coachThinking ? 'Thinking' : 'Fast'}</span>
                  </button>

                  <div ref={strategyRef} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="gem-tool-pill"
                      onClick={() => setStrategyOpen((o) => !o)}
                      aria-expanded={strategyOpen}
                      title="Portfolio strategy the coach follows for new money"
                    >
                      <span>◉</span>
                      <span>{strategyName}</span>
                    </button>
                    {strategyOpen && (
                      <div className="gem-strategy-pop">
                        {Object.values(FAMED_STRATEGIES).map((s) => (
                          <button
                            key={s.key}
                            type="button"
                            className={`gem-strategy-opt${s.key === coachStrategy ? ' on' : ''}`}
                            onClick={() => setStrategy(s.key)}
                          >
                            <div className="gem-strategy-name">{s.name}</div>
                            <div className="gem-strategy-blurb">{s.blurb}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  className="gem-send-btn"
                  type="submit"
                  aria-label="Send message"
                  disabled={pending || (!draft.trim() && !attach)}
                >
                  <IArrowUp size={17} />
                </button>
              </div>
            </form>

            <p className="gem-disclaimer">
              OmniFlow Coach reads only your encrypted vault. Verify key figures before acting.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
