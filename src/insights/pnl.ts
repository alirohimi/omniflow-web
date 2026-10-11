// ============================================================================
// OmniFlow — P&L / disposals reports engine (pure, $0, offline).
//
// Realised gains & losses from `Disposal` events, plus a trailing-period P&L
// summary. A disposal captures the sale of `units` at `salePrice` against a
// `costBasisPerUnit`, in a native `currency`; everything is normalised to the
// base currency via `toBase` (NaN-proof).
// ============================================================================

import type { Disposal } from '../domain/types';

/** (amount, currency) => base-currency amount. Callers pass a NaN-proof converter. */
type ToBase = (amount: number, from: string) => number;

export interface DisposalRealised {
  id: string;
  symbol: string;
  date: number;
  units: number;
  /** Realised P&L in base currency: (salePrice - costBasisPerUnit) * units. */
  pnl: number;
  saleValue: number; // base currency
  costValue: number; // base currency
}

export interface PnLSummary {
  totalRealised: number; // base currency, all-time
  totalRealisedInWindow: number;
  winners: DisposalRealised[]; // pnl > 0, largest first
  losers: DisposalRealised[]; // pnl < 0, most-negative first
  count: number;
  countInWindow: number;
}

/** Realised P&L per disposal (base currency). */
export function realisedPerDisposal(disposals: Disposal[], toBase: ToBase): DisposalRealised[] {
  return disposals.map((d) => {
    const saleValue = toBase(d.salePrice * d.units, d.currency);
    const costValue = toBase(d.costBasisPerUnit * d.units, d.currency);
    const pnl =
      Number.isFinite(saleValue) && Number.isFinite(costValue) ? saleValue - costValue : 0;
    return {
      id: d.id,
      symbol: d.symbol,
      date: d.date,
      units: d.units,
      pnl,
      saleValue,
      costValue,
    };
  });
}

/**
 * P&L summary over an optional window. `from`/`to` are epoch-ms bounds; omit
 * for all-time. Winners/losers are sorted by magnitude.
 */
export function pnlSummary(
  disposals: Disposal[],
  toBase: ToBase,
  from?: number,
  to?: number,
): PnLSummary {
  const all = realisedPerDisposal(disposals, toBase);
  const inWindow = all.filter((r) => (from === undefined || r.date >= from) && (to === undefined || r.date <= to));

  const sum = (rows: DisposalRealised[]) =>
    rows.reduce((s, r) => (Number.isFinite(r.pnl) ? s + r.pnl : s), 0);

  const winners = all
    .filter((r) => r.pnl > 0)
    .sort((a, b) => b.pnl - a.pnl);
  const losers = all
    .filter((r) => r.pnl < 0)
    .sort((a, b) => a.pnl - b.pnl);

  return {
    totalRealised: sum(all),
    totalRealisedInWindow: sum(inWindow),
    winners,
    losers,
    count: all.length,
    countInWindow: inWindow.length,
  };
}

/**
 * Realised P&L as CSV (all-time). Deterministic, RFC-4180-ish quoting; the
 * Reports tab can download this or pipe it to the browser. Columns:
 * date, symbol, units, saleValueBase, costValueBase, pnlBase.
 */
export function pnlToCsv(disposals: Disposal[], toBase: ToBase, baseCurrency: string): string {
  const rows = realisedPerDisposal(disposals, toBase);
  const head = ['date', 'symbol', 'units', 'saleValueBase', 'costValueBase', 'pnlBase'];
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.date).toISOString().slice(0, 10),
        esc(r.symbol),
        r.units.toFixed(4),
        r.saleValue.toFixed(2),
        r.costValue.toFixed(2),
        r.pnl.toFixed(2),
      ].join(','),
    );
  }
  // baseCurrency is part of the metadata block a caller may prepend.
  void baseCurrency;
  return lines.join('\n');
}
