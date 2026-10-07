// ============================================================================
// Expenses — capture pipeline (manual + OCR) + list + auto-categorize.
//
// Mirrors the iOS modules:
//   - "manual" = the Apple Pay automation path (merchant + amount + currency).
//   - "ocr"    = the QR/e-wallet screenshot path (image -> Tesseract -> AI).
// The AIManager equivalent here is `categorize` (LLM BYOK -> dictionary).
// ============================================================================

import { useMemo, useRef, useState } from 'react';
import { useVaultStore } from '../store/store';
import { useToast } from '../components/Toast';
import { DelButton } from '../components/DelButton';
import { fxService } from '../services';
import { parseReceipt } from '../services';
import { categorize } from '../ai';
import { CURRENCIES, currencyInfo, formatMoney } from '../domain/enums';
import { IReceipt, IScan } from '../icons';
import type { Expense } from '../domain/types';

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

  // ---- OCR form state
  const fileRef = useRef<HTMLInputElement>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrResult, setOcrResult] = useState<{ amount: number | null; currency: string; merchant: string } | null>(null);

  const sorted = useMemo(
    () => [...vault.expenses].sort((a, b) => b.timestamp - a.timestamp),
    [vault.expenses],
  );

  const totalMonth = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return vault.expenses
      .filter((e) => e.timestamp >= start.getTime() && e.category !== 'Income')
      .reduce((s, e) => s + e.baseAmount, 0);
  }, [vault.expenses]);

  // AI auto-categorize when merchant changes (mirrors AIManager Tier routing).
  const categorizeMerchant = async (m: string) => {
    setMerchant(m);
    if (!m.trim()) { setCat(''); setAiMsg(null); return; }
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
    store.addExpense({
      originalAmount: a,
      originalCurrency: cur,
      fxRate: rate,
      category: cat || 'Other',
      aiTier: (aiMsg?.startsWith('AI: llm-byok') ? 'llm-byok' : 'dictionary') as Expense['aiTier'],
      merchant: merchant.trim(),
      paymentMethod: pm,
      source: 'manual',
      note: note.trim() || undefined,
    });
    toast(`Saved ${merchant.trim()} · ${formatMoney(a, cur)}${cur !== base ? ` → ${base}` : ''}`);
    setAmount(''); setMerchant(''); setNote(''); setCat(''); setAiMsg(null);
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

  return (
    <>
      <h2 className="section-title">Capture</h2>
      <div className="card">
        <div className="row">
          <span className="chip"><IReceipt size={14} /> Manual / Apple Pay</span>
          <span className="chip"><IScan size={14} /> QR / e-wallet OCR</span>
        </div>

        <label className="field"><span>Amount</span>
          <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <div className="cols">
          <label className="field"><span>Currency</span>
            <select value={cur} onChange={(e) => setCur(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.name})</option>)}
            </select>
          </label>
          <label className="field"><span>Payment</span>
            <select value={pm} onChange={(e) => setPm(e.target.value as typeof pm)}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Merchant (auto-categorized by AI)</span>
          <input value={merchant} onChange={(e) => void categorizeMerchant(e.target.value)} placeholder="e.g. 7-Eleven, Luno, Grab" />
        </label>
        {aiMsg && <div className="small muted">{aiMsg}</div>}
        <label className="field"><span>Category</span>
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {vault.categories.map((c) => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Note (optional)</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="receipt text, reference…" />
        </label>
        <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={() => void saveManual()}>
          {busy ? 'Working…' : `Save expense ${cur !== base ? `(${cur}→${base})` : ''}`}
        </button>
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

      <h2 className="section-title">History</h2>
      <div className="row muted small" style={{ marginBottom: 6 }}>
        <span>{sorted.length} total</span>
        <span>{sym}{totalMonth.toFixed(0)} this month</span>
      </div>
      <div className="list">
        {sorted.slice(0, 60).map((e) => (
          <div className="item" key={e.id}>
            <div className="grow">
              <div className="title">{e.merchant}</div>
              <div className="meta">
                {e.category} · {e.paymentMethod} · {new Date(e.timestamp).toLocaleDateString()}
                {e.originalCurrency !== base ? ` · ${formatMoney(e.originalAmount, e.originalCurrency)}` : ''}
              </div>
            </div>
            <div className="amt">{sym}{e.baseAmount.toFixed(2)}</div>
            <DelButton
              label={`Delete ${e.merchant}`}
              onConfirm={() => {
                store.deleteExpense(e.id);
                toast(`Deleted ${e.merchant}`);
              }}
            />
          </div>
        ))}
        {sorted.length === 0 && <div className="empty">No expenses yet. Add one above or load the demo data in Settings.</div>}
      </div>
    </>
  );
}
