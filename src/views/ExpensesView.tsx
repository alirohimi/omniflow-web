// ============================================================================
// Expenses — capture pipeline (manual + OCR) + list + auto-categorize.
//
// Mirrors the iOS modules:
//   - "manual" = the Apple Pay automation path (merchant + amount + currency).
//   - "ocr"    = the QR/e-wallet screenshot path (image -> Tesseract -> AI).
// The AIManager equivalent here is `categorize` (LLM BYOK -> dictionary).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { fxService } from '../services';
import {
  parseReceipt,
  extractPdfText,
  parseStatementText,
  type ParsedStatementLine,
} from '../services';
import { categorize } from '../ai';
import { CURRENCIES, currencyInfo, formatMoney } from '../domain/enums';
import { IReceipt, IScan, ICheck, ISearch, IFilter } from '../icons';
import { SpendingBreakdown } from '../components/SpendingBreakdown';
import type { Expense, PendingImport } from '../domain/types';

const PAYMENT_METHODS = ['card', 'qr', 'ewallet', 'cash', 'bank', 'other'] as const;

export function ExpensesView() {
  const store = useVaultStore();
  const { toast } = useToast();
  const { vault } = store;
  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const sym = currencyInfo(base).symbol;

  // ---- manual / Apple-Pay-style form state
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(base);
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [pm, setPm] = useState<(typeof PAYMENT_METHODS)[number]>('card');
  const [cat, setCat] = useState('');
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isIncome, setIsIncome] = useState(false);

  // ---- OCR form state
  const fileRef = useRef<HTMLInputElement>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrResult, setOcrResult] = useState<{ amount: number | null; currency: string; merchant: string } | null>(null);

  // ---- multi-select delete state (History). Two-tap armed delete reuses the
  //      same pattern as single-row DelButton so a mass delete is never
  //      accidental. Selection is a Set of ids so it survives filtering
  //      (Task 003 removed the old 60-row display cap; the list now renders
  //      the full filtered set).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkArmed, setBulkArmed] = useState(false);
  const bulkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bulkArmed) return;
    bulkTimer.current = setTimeout(() => setBulkArmed(false), 2500);
    return () => { if (bulkTimer.current) clearTimeout(bulkTimer.current); };
  }, [bulkArmed]);

  // Drop any selected ids that no longer exist (a row was deleted out-of-band).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(vault.expenses.map((e) => e.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [vault.expenses]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    // Toggle: if every visible (filtered) row is already picked, tapping
    // clears the whole selection; otherwise select everything visible.
    // (The previous "early return when all selected" meant the button read
    // as broken.) Operates on `visible` so bulk-delete respects filters.
    const allVisiblePicked =
      visible.length > 0 && visible.every((e) => selected.has(e.id));
    setSelected(allVisiblePicked ? new Set() : new Set(visible.map((e) => e.id)));
  };

  const clearSelection = () => {
    if (selected.size === 0) return;
    setSelected(new Set());
    setBulkArmed(false);
  };

  const bulkDelete = () => {
    const count = selected.size;
    if (count === 0) return;
    store.deleteExpenses([...selected]);
    setSelected(new Set());
    setBulkArmed(false);
    toast(`Deleted ${count} row${count === 1 ? '' : 's'}.`);
  };

  const selectedTotal = useMemo(
    () => [...selected].reduce((sum, id) => {
      const e = vault.expenses.find((x) => x.id === id);
      return sum + (e ? e.baseAmount : 0);
    }, 0),
    [selected, vault.expenses],
  );

  const sorted = useMemo(
    () => [...vault.expenses].sort((a, b) => b.timestamp - a.timestamp),
    [vault.expenses],
  );

  // ---- History filters + search (session-only, compose with AND) ----------
  type HistRange = 'all' | 'month' | '30d' | '90d';
  type HistType = 'all' | 'expense' | 'income';
  const [q, setQ] = useState('');
  const [catF, setCatF] = useState<string>('all'); // category name or 'all'
  const [rangeF, setRangeF] = useState<HistRange>('all');
  const [typeF, setTypeF] = useState<HistType>('all');
  // Collapsible filter bar: closed by default on mobile, force-open whenever
  // a filter/search is active (a closed bar with an active filter would be
  // confusing — the "Showing X of Y" + "clear filters" already signals state).
  const [filtersOpen, setFiltersOpen] = useState(false);

  const rangeStart = useMemo(() => {
    if (rangeF === 'month') {
      const d = new Date();
      d.setDate(1); d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    if (rangeF === '30d') return Date.now() - 30 * 86_400_000;
    if (rangeF === '90d') return Date.now() - 90 * 86_400_000;
    return 0; // 'all'
  }, [rangeF]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sorted.filter((e) => {
      if (rangeStart && e.timestamp < rangeStart) return false;
      if (typeF === 'income' ? e.category !== 'Income' : typeF === 'expense' ? e.category === 'Income' : false) return false;
      if (catF !== 'all' && e.category !== catF) return false;
      if (needle) {
        const hay = [e.merchant, e.note ?? '', e.category, e.paymentMethod, e.originalCurrency]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [sorted, q, catF, rangeF, typeF, rangeStart]);

  const filtersActive = q.trim() !== '' || catF !== 'all' || rangeF !== 'all' || typeF !== 'all';

  const catOptions = useMemo(
    () => [...new Set(vault.expenses.map((e) => e.category))].sort(),
    [vault.expenses],
  );

  const clearFilters = () => { setQ(''); setCatF('all'); setRangeF('all'); setTypeF('all'); };

  // Drives the "Select all" toolbar button state (check + "All selected").
  // Operates on the VISIBLE (filtered) set, so bulk-delete respects filters.
  const allPicked =
    visible.length > 0 && visible.every((e) => selected.has(e.id));

  const totalMonth = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return vault.expenses
      .filter((e) => e.timestamp >= start.getTime() && e.category !== 'Income')
      .reduce((s, e) => s + e.baseAmount, 0);
  }, [vault.expenses]);

  // ---- AI auto-categorize debounce (fired per keystroke; 300 ms debounce
  //      so rapid typing doesn't spam the BYOK LLM).
  const catTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const categorizeMerchant = (m: string) => {
    setMerchant(m);
    if (!m.trim()) { setCat(''); setAiMsg(null); return; }
    if (catTimerRef.current) clearTimeout(catTimerRef.current);
    catTimerRef.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await categorize(
          { merchant: m, currency: cur, amount: parseFloat(amount) || undefined },
          vault.categories,
          store.llmConfig ?? undefined,
        );
        setCat(r.category);
        setAiMsg(`AI: ${r.tier} · ${Math.round(r.confidence * 100)}% · "${r.category}"`);
      } catch {
        setCat('');
        setAiMsg('AI categorize failed; pick manually.');
      } finally {
        setBusy(false);
      }
    }, 300);
  };

  const saveManual = async () => {
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0 || !merchant.trim()) return;
    let rate = 1;
    if (cur !== base) {
      try {
        const r = await fxService.latest(base);
        rate = fxService.toBase(1, cur, r); // units of base per 1 cur
      } catch {
        rate = 1; // offline: keep original amount as a rough base
      }
    }
    const finalCategory = isIncome ? 'Income' : (cat || 'Other');
    store.addExpense({
      originalAmount: a,
      originalCurrency: cur,
      fxRate: rate,
      category: finalCategory,
      aiTier: isIncome ? 'dictionary' : ((aiMsg?.startsWith('AI: llm-byok') ? 'llm-byok' : 'dictionary') as Expense['aiTier']),
      merchant: merchant.trim(),
      paymentMethod: isIncome ? 'bank' : pm,
      source: 'manual',
      note: note.trim() || undefined,
    });
    toast(
      isIncome
        ? `Income saved · ${merchant.trim()} · ${formatMoney(a, cur)}`
        : `Saved ${merchant.trim()} · ${formatMoney(a, cur)}${cur !== base ? ` → ${base}` : ''}`,
    );
    setAmount(''); setMerchant(''); setNote(''); setCat(''); setAiMsg(null);
    setIsIncome(false);
  };

  const runOcr = async (file: File) => {
    setOcrBusy(true); setOcrResult(null); setOcrProgress(0);
    try {
      const parsed = await parseReceipt(
        file,
        base,
        (p) => setOcrProgress(Math.round(p * 100)),
        store.llmConfig ?? undefined,
      );
      setOcrResult(parsed);
      if (parsed.merchant) void categorizeMerchant(parsed.merchant);
      if (parsed.amount != null) setAmount(String(parsed.amount));
      if (parsed.currency) setCur(parsed.currency);
      // Stash the raw OCR text for the record.
      setNote((n) => (n ? n : `OCR: ${parsed.rawText.slice(0, 200)}`));
    } catch (e) {
      setAiMsg(`OCR failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setOcrBusy(false); setOcrProgress(null);
    }
  };

  // ---- PDF statement import state.
  // `vault.pendingImport` (persisted, encrypted) is the source of truth that an
  // import is in flight; the React state below is the snappy editing surface.
  // Two phases survive a refresh: 'parse' (raw text extracted, re-parse on
  // resume) and 'review' (rows derived, restore the review screen directly).
  const pdfRef = useRef<HTMLInputElement>(null);
  const pdfAbort = useRef<AbortController | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfPhase, setPdfPhase] = useState<string | null>(null);
  const [pdfProgress, setPdfProgress] = useState<number | null>(null);
  const [pdfRows, setPdfRows] = useState<ParsedStatementLine[] | null>(null);
  const [pdfMeta, setPdfMeta] = useState<{ parser: 'llm' | 'regex'; fileName: string; llmError?: string } | null>(null);
  const [pdfDisabled, setPdfDisabled] = useState<Set<number>>(new Set());
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfImporting, setPdfImporting] = useState(false);

  // One-shot refresh rehydration. Runs on mount: if the encrypted blob still
  // holds a pending import (a refresh happened mid-import), restore it. The
  // ref guard means a later render re-applying the effect never re-triggers.
  const rehydrated = useRef(false);
  useEffect(() => {
    if (rehydrated.current) return;
    rehydrated.current = true;
    const p = store.vault?.pendingImport;
    if (!p) return; // no in-flight import: nothing to restore
    if (p.phase === 'review' && p.lines.length > 0) {
      // Rows already derived — restore the review screen as the user left it.
      setPdfRows(p.lines);
      setPdfMeta({ parser: p.parser, fileName: p.fileName, llmError: p.llmError });
      setPdfDisabled(new Set(p.disabled));
    } else if (p.phase === 'parse' && p.text) {
      // Text extracted but not yet parsed — re-derive the rows from it.
      void resumeParsePhase(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelPdfParse = () => {
    pdfAbort.current?.abort();
  };

  const finishPdfBusy = () => {
    setPdfBusy(false);
    setPdfPhase(null);
    setPdfProgress(null);
    pdfAbort.current = null;
  };

  // Re-parse persisted raw text (a refresh happened between extract and parse).
  const resumeParsePhase = async (p: PendingImport) => {
    setPdfBusy(true);
    setPdfPhase('Resuming import…');
    setPdfProgress(null);
    setPdfError(null);
    const ac = new AbortController();
    pdfAbort.current = ac;
    try {
      const result = await parseStatementText(p.text ?? '', {
        llm: store.llmConfig ?? undefined,
        categories: store.vault?.categories,
        signal: ac.signal,
        onProgress: (x, ph) => {
          setPdfPhase(ph);
          setPdfProgress(x);
        },
      });
      if (result.lines.length === 0) {
        store.setPendingImport(null);
        setPdfError('No transactions found. If the PDF is a scanned image (no text layer), use the QR / screenshot OCR path instead.');
        return;
      }
      // Rows now derived — move the checkpoint to the review phase.
      store.setPendingImport({
        phase: 'review',
        text: p.text,
        fileName: p.fileName,
        parser: result.parser,
        llmError: result.llmError,
        lines: result.lines,
        disabled: p.disabled,
        createdAt: p.createdAt,
      });
      setPdfRows(result.lines);
      setPdfMeta({ parser: result.parser, fileName: p.fileName, llmError: result.llmError });
      setPdfDisabled(new Set(p.disabled));
    } catch (e) {
      if (ac.signal.aborted) {
        // Cancelled: keep the checkpoint so a later resume can re-parse.
        setPdfError('Import cancelled. It can be resumed from Settings → Pending import.');
      } else {
        setPdfError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      finishPdfBusy();
    }
  };

  const runPdfImport = async (file: File) => {
    const createdAt = Date.now();
    setPdfBusy(true);
    setPdfRows(null);
    setPdfMeta(null);
    setPdfError(null);
    setPdfDisabled(new Set());
    setPdfProgress(null);
    const ac = new AbortController();
    pdfAbort.current = ac;
    setPdfPhase('Reading PDF');
    try {
      // Phase A: extract the text layer. Checkpoint it immediately so a refresh
      // that lands before the file handle closes can resume from text, not
      // by re-picking the file.
      let text: string;
      try {
        text = await extractPdfText(file, () => setPdfPhase('Reading PDF'));
      } catch (e) {
        store.setPendingImport(null);
        throw new Error(
          'Could not read that PDF. ' +
            (e instanceof Error ? e.message : '') +
            ' It may be scanned-image-only (no text layer).',
        );
      }
      store.setPendingImport({
        phase: 'parse',
        text,
        fileName: file.name,
        parser: 'regex', // placeholder; finalized when parsing completes
        lines: [],
        disabled: [],
        createdAt,
      });

      // Phase B: parse + auto-categorize the extracted text.
      setPdfPhase('Parsing');
      const result = await parseStatementText(text, {
        llm: store.llmConfig ?? undefined,
        categories: vault.categories,
        signal: ac.signal,
        onProgress: (x, phase) => {
          setPdfPhase(phase);
          setPdfProgress(x);
        },
      });

      if (result.lines.length === 0) {
        store.setPendingImport(null);
        setPdfError(
          'No transactions found. If the PDF is a scanned image (no text layer), ' +
            'use the QR / screenshot OCR path instead.',
        );
        return;
      }

      // Checkpoint: rows derived — a refresh now restores the review screen.
      store.setPendingImport({
        phase: 'review',
        text,
        fileName: file.name,
        parser: result.parser,
        llmError: result.llmError,
        lines: result.lines,
        disabled: [],
        createdAt,
      });
      setPdfRows(result.lines);
      setPdfMeta({ parser: result.parser, fileName: file.name, llmError: result.llmError });
    } catch (e) {
      if (ac.signal.aborted) {
        // Cancelled mid-parse: keep the checkpoint so Settings → Resume can
        // re-derive rows from the already-extracted text.
        setPdfError('Import cancelled. You can resume it from Settings → Pending import.');
      } else {
        setPdfError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      finishPdfBusy();
    }
  };

  const patchRow = (i: number, patch: Partial<ParsedStatementLine>) => {
    setPdfRows((rows) => (rows ? rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) : rows));
  };

  const toggleRow = (i: number) => {
    setPdfDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const discardPdf = () => {
    setPdfRows(null);
    setPdfMeta(null);
    setPdfDisabled(new Set());
    setPdfError(null);
    store.setPendingImport(null); // drop the in-flight checkpoint
  };

  const importRows = async () => {
    if (!pdfRows || !pdfMeta) return;
    setPdfImporting(true);
    const enabledIdx = pdfRows.map((_, i) => i).filter((i) => !pdfDisabled.has(i));
    // Incoming money (deposits, salary, refunds) is never an expense — only
    // outflows are tracked, so 'in' rows are excluded from the import even
    // if the user ticks them in the review table.
    const inCount = pdfRows.filter((r) => r.direction === 'in').length;
    const importIdx = enabledIdx.filter((i) => pdfRows[i].direction !== 'in');
    if (importIdx.length === 0) {
      toast(inCount > 0 ? `No outflows to import — ${inCount} incoming line(s) excluded.` : 'Nothing to import.');
      setPdfImporting(false);
      if (inCount === 0) {
        setPdfRows(null);
        setPdfMeta(null);
        setPdfDisabled(new Set());
      }
      return;
    }
    // Fetch FX once for any foreign currencies present.
    const foreign = [...new Set(importIdx.map((i) => pdfRows[i].currency).filter((c): c is string => !!c))]
      .filter((c) => c !== base);
    let rates = null;
    if (foreign.length > 0) {
      try {
        rates = await fxService.latest(base);
      } catch {
        rates = null; // offline: import in original currency, rate 1
      }
    }
    const inputs: Parameters<typeof store.addExpenses>[0] = importIdx.map((i) => {
      const row = pdfRows[i];
      const currency = row.currency || base;
      const rate =
        currency === base || !rates ? 1 : fxService.toBase(1, currency, rates);
      const isIncome = row.direction === 'in';
      return {
        originalAmount: row.amount,
        originalCurrency: currency,
        fxRate: isFinite(rate) ? rate : 1,
        category: row.category || (isIncome ? 'Income' : 'Other'),
        aiTier: row.aiTier ?? 'dictionary',
        merchant: row.merchant.trim() || 'Unknown',
        paymentMethod: 'bank' as const,
        source: 'import' as const,
        note: `Imported from ${pdfMeta.fileName} (${pdfMeta.parser})` +
          (row.raw ? ` · ${row.raw.slice(0, 120)}` : ''),
        timestamp: row.date,
      };
    });
    store.addExpenses(inputs);
    store.setPendingImport(null); // import finished — clear the checkpoint
    const excluded = enabledIdx.length - importIdx.length;
    toast(
      `Imported ${importIdx.length} outflow${importIdx.length === 1 ? '' : 's'} from ${pdfMeta.fileName}` +
        (excluded > 0 ? ` · ${excluded} incoming line(s) excluded` : inCount > 0 ? ` · ${inCount} incoming excluded` : ''),
    );
    setPdfRows(null);
    setPdfMeta(null);
    setPdfDisabled(new Set());
    setPdfImporting(false);
  };

  return (
    <>
      <h2 className="section-title">Capture</h2>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip sm"><IReceipt size={14} /> Manual / Apple Pay</span>
            <span className="chip sm"><IScan size={14} /> QR / e-wallet OCR</span>
          </div>
          <button
            className={`btn ghost sm ${isIncome ? '' : 'off'}`}
            onClick={() => { setIsIncome((v) => !v); if (!isIncome) setCat(''); }}
            aria-pressed={isIncome}
            style={{ flex: 'none' }}
          >
            {isIncome ? 'Income' : 'Expense'}
          </button>
        </div>

        <label className="field"><span>{isIncome ? 'Income source' : 'Amount'}</span>
          <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <div className="cols">
          <label className="field"><span>Currency</span>
            <select value={cur} onChange={(e) => setCur(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.name})</option>)}
            </select>
          </label>
          {!isIncome && (
            <label className="field"><span>Payment</span>
              <select value={pm} onChange={(e) => setPm(e.target.value as typeof pm)}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className="field"><span>{isIncome ? 'Source (e.g. salary, freelance)' : 'Merchant (auto-categorized by AI)'}</span>
          <input value={merchant} onChange={(e) => void categorizeMerchant(e.target.value)} placeholder={isIncome ? 'e.g. salary, freelance, rental' : 'e.g. 7-Eleven, Luno, Grab'} />
        </label>
        {isIncome ? (
          <div className="small muted">Income is tracked separately from spend and excluded from all budget / pace calculations.</div>
        ) : aiMsg ? <div className="small muted">{aiMsg}</div> : null}
        {!isIncome && (
          <label className="field"><span>Category</span>
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              {vault.categories.filter((c) => c.name !== 'Income').map((c) => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>Note (optional)</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="receipt text, reference…" />
        </label>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => void saveManual()}>
            {busy ? 'Working…' : isIncome
              ? 'Save income'
              : `Save expense ${cur !== base ? `(${cur}→${base})` : ''}`}
          </button>
          {!isIncome && (
            <button
              className="btn ghost sm"
              style={{ flex: 'none' }}
              onClick={() => { setIsIncome(true); setCat(''); setAiMsg(null); }}
            >
              Add income
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Scan a payment / QR screenshot</h3>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && void runOcr(e.target.files[0])} />
        <button className="btn ghost sm" disabled={ocrBusy} onClick={() => fileRef.current?.click()}>
          {ocrBusy ? `OCR ${ocrProgress != null ? ocrProgress + '%' : '…'}` : 'Choose image'}
        </button>
        {ocrResult && (
          <div className="small muted" style={{ marginTop: 8 }}>
            Found: {ocrResult.amount != null ? ocrResult.amount : '?'} {ocrResult.currency} @ {ocrResult.merchant}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Import a statement (PDF)</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Monthly bank / card / e-wallet statement. The PDF is read on your
          device (never uploaded). Bank tables (Maybank/M2U, CIMB, RHB, card
          statements) are parsed with built-in rules — the transaction amount is
          read from the signed amount column, not the running balance; AI is
          used only to verify/complete uncertain merchants. Auto-categorizes
          each merchant. Review and edit before importing.
          {store.llmConfig ? ' Uses your AI key for verification.' : ' No key needed.'}
        </p>
        <input ref={pdfRef} type="file" accept="application/pdf" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void runPdfImport(f);
          }} />
        <button className="btn ghost sm" disabled={pdfBusy} onClick={() => pdfRef.current?.click()}>
          <IReceipt size={15} />
          {pdfBusy ? pdfPhase ?? 'Working…' : 'Choose PDF statement'}
        </button>
        {pdfBusy && pdfPhase && (
          <div style={{ marginTop: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <div className="spinner sm" aria-hidden />
              <span className="small muted grow" style={{ minWidth: 0 }}>{pdfPhase}…</span>
              {pdfProgress != null && (
                <span className="small mono">{Math.round(pdfProgress * 100)}%</span>
              )}
              <button className="btn ghost sm" onClick={cancelPdfParse} type="button">
                Cancel
              </button>
            </div>
            {pdfProgress != null && (
              <div
                className="bar"
                role="progressbar"
                aria-valuenow={Math.round(pdfProgress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{ marginTop: 8 }}
              >
                <i style={{ width: `${Math.round(pdfProgress * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {pdfError && <div className="small" style={{ color: 'var(--bad)', marginTop: 8 }}>{pdfError}</div>}

        {pdfRows && pdfMeta && (
          <div style={{ marginTop: 12 }}>
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="chip sm">{pdfRows.length} found</span>
              {pdfRows.filter((r) => r.direction === 'in').length > 0 && (
                <span className="chip sm" title="Incoming money (deposits, refunds) is not tracked as an expense">
                  {pdfRows.filter((r) => r.direction === 'in').length} incoming excluded
                </span>
              )}
              <span className="chip sm {pdfMeta.parser === 'llm' ? 'ok' : ''}">
                {pdfMeta.parser === 'llm' ? 'AI-extracted' : 'rules-parsed'}
              </span>
              <span className="muted">{pdfMeta.fileName}</span>
            </div>
            {pdfMeta.parser === 'llm' && pdfMeta.llmError && (
              <div className="small muted" style={{ marginBottom: 8 }}>{pdfMeta.llmError}</div>
            )}
            {pdfRows.map((row, i) => {
              const off = pdfDisabled.has(i);
              const isIncome = row.direction === 'in';
              // Incoming rows are never importable — the commit step drops
              // them, so show that explicitly instead of a live checkbox.
              return (
                <div key={i} className="item" style={{ opacity: isIncome ? 0.5 : off ? 0.45 : 1 }}>
                  {isIncome ? (
                    <span className="chip sm" style={{ flex: 'none', marginTop: 2 }} title="Incoming money is not tracked as an expense">in</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() => toggleRow(i)}
                      style={{ width: 18, height: 18, flex: 'none', marginTop: 2 }}
                      aria-label={`Include ${row.merchant}`}
                    />
                  )}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="title" style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <input
                        value={row.merchant}
                        onChange={(e) => patchRow(i, { merchant: e.target.value })}
                        style={{ minWidth: 0, flex: 1, padding: '2px 4px', minHeight: 0, fontSize: 14 }}
                        aria-label="Merchant"
                      />
                      <select
                        value={row.direction}
                        onChange={(e) => patchRow(i, { direction: e.target.value as 'in' | 'out', category: e.target.value === 'in' ? 'Income' : row.category || 'Other' })}
                        style={{ flex: 'none', width: 74, padding: '2px 4px', minHeight: 0, fontSize: 12.5 }}
                        aria-label="Direction"
                      >
                        <option value="out">out</option>
                        <option value="in">in</option>
                      </select>
                    </div>
                    <div className="meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        type="number"
                        inputMode="decimal"
                        value={row.amount}
                        onChange={(e) => patchRow(i, { amount: Number(e.target.value) })}
                        style={{ width: 92, padding: '2px 6px', minHeight: 0, fontSize: 12.5 }}
                        aria-label="Amount"
                      />
                      <select
                        value={row.currency || base}
                        onChange={(e) => patchRow(i, { currency: e.target.value })}
                        style={{ width: 84, padding: '2px 6px', minHeight: 0, fontSize: 12.5 }}
                        aria-label="Currency"
                      >
                        {[...new Set([base, ...CURRENCIES.map((c) => c.code)])].map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <select
                        value={row.category || (isIncome ? 'Income' : 'Other')}
                        onChange={(e) => patchRow(i, { category: e.target.value })}
                        style={{ width: 130, padding: '2px 6px', minHeight: 0, fontSize: 12.5 }}
                        aria-label="Category"
                      >
                        {vault.categories.map((c) => (
                          <option key={c.id} value={c.name}>{c.icon} {c.name}</option>
                        ))}
                      </select>
                      {row.date && (
                        <span>{new Date(row.date).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="amt">
                    {isIncome ? '+' : ''}{currencyInfo(row.currency || base).symbol}
                    {row.amount.toFixed(2)}
                    {row.currency && row.currency !== base ? (
                      <div className="meta" style={{ textAlign: 'right' }}>in {row.currency}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button
                className="btn sm"
                style={{ flex: 1 }}
                disabled={pdfImporting}
                onClick={() => void importRows()}
              >
                {pdfImporting
                  ? 'Importing…'
                  : `Import ${pdfRows.length - pdfDisabled.size} ${pdfRows.length - pdfDisabled.size === 1 ? 'transaction' : 'transactions'}`}
              </button>
              <button className="btn ghost sm" onClick={discardPdf}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Spending breakdown: window selector + category / payment-method /
          merchant aggregation + budget performance. All math lives in the
          `spendingBreakdown` engine so it stays unit-testable; this is pure
          presentation. */}
      <SpendingBreakdown
        expenses={vault.expenses}
        budgets={vault.budgets ?? []}
        baseCurrency={base}
      />

      <h2 className="section-title">History</h2>
      <div className="row muted small" style={{ marginBottom: 6, justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          {filtersActive ? `Showing ${visible.length} of ${sorted.length}` : `${sorted.length} total`}
          {filtersActive ? <button type="button" className="hist-clear" onClick={clearFilters}> clear filters</button> : null}
        </span>
        <button
          type="button"
          className={`chip sm${filtersActive ? ' on' : ''}`}
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-label="Toggle filters"
        >
          <IFilter size={13} />
          Filters{filtersActive ? ' · on' : ''}
        </button>
      </div>

      {/* Filter + search bar. Every control is themed (no native browser
          controls); search matches merchant, note, category, payment
          method and currency case-insensitively. Filters compose (AND).
          Collapsible on mobile via the "Filters" chip above; stays open
          when a filter is active (can't trap the user inside a closed bar
          with an active filter). */}
      {(filtersOpen || filtersActive) && (
      <div className="hist-filters">
        <label className="field hist-search">
          <ISearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search merchant, note, category…"
            aria-label="Search transactions"
          />
        </label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <div className="seg" role="tablist" aria-label="Type">
            {([
              ['all', 'All'],
              ['expense', 'Expenses'],
              ['income', 'Income'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={typeF === id}
                onClick={() => setTypeF(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="seg" role="tablist" aria-label="Date range">
            {([
              ['all', 'All time'],
              ['month', 'This month'],
              ['30d', '30d'],
              ['90d', '90d'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={rangeF === id}
                onClick={() => setRangeF(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="hist-cats">
          <button type="button" className={`chip sm${catF === 'all' ? ' on' : ''}`} onClick={() => setCatF('all')}>
            All categories
          </button>
          {catOptions.map((c) => (
            <button key={c} type="button" className={`chip sm${catF === c ? ' on' : ''}`} onClick={() => setCatF(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Multi-select. "Select all" toggles the whole list; "Clear" wipes the
          selection. The bulk delete is the armed two-tap destructive action.
          The row control below is a themed check-chip, not a native checkbox. */}
      {sorted.length > 0 && (
        <div className="selbar">
          <div className="selbar-l">
            <button
              type="button"
              className={`selbar-toggle${allPicked ? ' on' : ''}`}
              onClick={selectAll}
              aria-pressed={allPicked}
            >
              <span className="selbar-box">{allPicked ? <ICheck size={13} /> : null}</span>
              {allPicked ? 'All selected' : 'Select all'}
            </button>
            {selected.size > 0 && (
              <button type="button" className="selbar-clear" onClick={clearSelection}>
                Clear
              </button>
            )}
          </div>
          {selected.size > 0 && (
            <div className="selbar-r">
              <span className="selbar-count">{selected.size} · {sym}{selectedTotal.toFixed(0)}</span>
              <button
                type="button"
                className={`selbar-del${bulkArmed ? ' armed' : ''}`}
                onClick={() => { if (bulkArmed) bulkDelete(); else setBulkArmed(true); }}
                aria-label={bulkArmed ? 'Confirm: delete selected expenses' : `Delete ${selected.size} selected expense(s)`}
              >
                {bulkArmed ? 'Confirm' : `Delete ${selected.size}`}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="list">
        {visible.map((e) => {
          const picked = selected.has(e.id);
          const isIncome = e.category === 'Income';
          return (
            <div className={`item sel-row${picked ? ' picked' : ''}`} key={e.id}>
              <button
                type="button"
                className={`selchip${picked ? ' on' : ''}`}
                onClick={() => toggleSelect(e.id)}
                aria-pressed={picked}
                aria-label={`${picked ? 'Deselect' : 'Select'} ${e.merchant}`}
              >
                {picked ? <ICheck size={15} /> : null}
              </button>
              <div className="grow">
                <div className="title">
                  {isIncome ? <span className="hist-inc" title="Income">+</span> : null}
                  {e.merchant}
                </div>
                <div className="meta">
                  {e.category} · {e.paymentMethod} · {new Date(e.timestamp).toLocaleDateString()}
                  {e.originalCurrency !== base ? ` · ${formatMoney(e.originalAmount, e.originalCurrency)}` : ''}
                </div>
              </div>
              <div className={`amt${isIncome ? ' income' : ''}`}>{isIncome ? '+' : ''}{sym}{e.baseAmount.toFixed(2)}</div>
              <DelButton
                label={`Delete ${e.merchant}`}
                onConfirm={() => {
                  store.deleteExpense(e.id);
                  toast(`Deleted ${e.merchant}`);
                }}
              />
            </div>
          );
        })}
        {visible.length === 0 && sorted.length > 0 && (
          <div className="empty">No transactions match your search / filters. <button type="button" className="hist-clear" onClick={clearFilters}>Clear them</button></div>
        )}
        {sorted.length === 0 && <div className="empty">No expenses yet. Add one above, or ask the Coach to log one for you.</div>}
      </div>
    </>
  );
}
