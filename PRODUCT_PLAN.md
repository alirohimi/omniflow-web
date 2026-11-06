# OmniFlow Web — Product Focus & Monetization Plan
Personas: finance-tracker + growth-hacker + senior-pm | 2026-10-15

---

## 1. Scope: keep / build / remove

### MUST exist (viable cashflow app)
- Expense capture: manual + OCR + PDF statement import (all present: ExpensesView.tsx, services/pdf.ts)
- Income tracking: works via category 'Income', but no dedicated UI to add income (fix: make first-class)
- Budgets: engine exists (insights/budgets.ts), UI is hidden inside SpendingBreakdown — surface it on the dashboard
- Recurring bills + PWA notifications: engine exists (insights/recurring.ts), prefs.billReminders — needs visibility on dashboard
- Cashflow forecast + "months until broke": engine exists (insights/forecast.ts) — not surfaced anywhere; add to dashboard
- Debt payoff plan: engine exists (insights/debt.ts) — not surfaced; add to dashboard
- CSV/OFX import: type exists (ExpenseSource='import'), no UI — add a simple file import
- Export to CSV (for tax/backup): trivial, do it
- Net worth time series: snapshot only; add daily/weekly auto-capture into a lightweight `netWorthHistory` entity

### REMOVE or defer (faster to PMF)
- Dividends + Disposal/P&L engine (insights/dividends.ts, insights/pnl.ts, types.Disposal): too many entities, no UI surface, tax-reporting complexity; defer to v2
- Rebalance planning (insights/rebalance.ts): high complexity, low frequency-of-use; defer
- BYOK LLM coach chat (ai/coach.ts, 483 lines, 636-line actions.ts): keep the *rule engine* tier; the conversational LLM chat is a cost center — gate it behind paid tier, don't build more free features
- 6 asset classes × 6 platforms in InvestmentsView: reduce to 3 asset classes (equity/ETF/cash + crypto); simplify
- Multi-currency FX snapshot: keep (differentiator), but stop adding new currencies
- PDF OCR (Tesseract, heavy): keep as secondary; primary statement path should be text-PDF regex parser (already in statement.ts)
- Admin/member directory (services/admin.ts): keep minimal, don't expand

### BUILD next (in order of revenue impact)
1. Cashflow forecast panel on dashboard (engine done, ~1 day UI work)
2. Budget + recurring-bill cards on dashboard (engines done, ~1 day)
3. CSV import/export (2–3 days)
4. Savings-goal entity + target tracker (new, ~2 days)
5. Net-worth history time series + chart (~1 day)
6. Payment integration (Stripe/Lemon Squeezy) — see monetization below

---

## 2. 12-month monetization plan

### Pricing benchmarks
| Product | Model | Price |
|---|---|---|
| YNAB | Subscription | $108/yr ($9/mo) |
| Copilot | Subscription | $5.99/mo |
| Rocket Money | Freemium | $0 → $60/yr |
| Actual Budget | Open source, self-hosted | Free |
| Monarch Money | Premium | $98/yr |
| Wallet (app) | Subscription | $12/mo |
| Firefly III | Self-hosted, community | $100 one-time for Pro |

OmniFlow is: self-contained, no bank feed (Plaid cost avoided), encrypted vault, PWA, multi-currency, crypto-aware.
Positioning: "Copilot + YNAB without the bank-feed subscription, for people who track manually or use PDF statements."

### Phase 0 (Months 1–2) — Validate
- Ship a public landing page (Vercel/GitHub Pages, $0) with waitlist
- Add 30 hand-picked beta users (friends, HN/IndieHackers)
- Instrument: activation = user adds 5+ expenses in first session; retention = return after 7 days
- Goal: 30 beta users, 40%+ 7-day retention before paying for infra

### Phase 1 (Months 3–5) — Freemium + Paid tier
- Free: expense tracking, budgets, recurring bills, 1 investment account, PDF import (3/month)
- Pro $6/mo or $50/yr: unlimited accounts, CSV import/export, cashflow forecast, debt payoff, net-worth history, unlimited PDF imports, LLM coach
- Payment: Lemon Squeezy (merchant of record, $0 setup, ~5% fee) — no Stripe onboarding for a solo dev in Malaysia
- Supabase: free tier covers <50K MAU; switch to Pro ($25/mo) at ~10K users
- Target: 50 paying users = $250–$300 MRR by month 5

### Phase 2 (Months 6–9) — Growth loops
- Export "Insight Report" (PDF, 1 page) with "Made with OmniFlow" footer → viral loop
- Referral: 1 month free for both sides (tracked via Supabase, no service needed)
- Launch on Product Hunt + r/personalfinance + r/MalaysiaMoney (SEA focus = low CAC)
- Target: 200 paying users = $1,200 MRR

### Phase 3 (Months 10–12) — Upsell
- Add "Family" tier $12/mo (2 seats, shared budgets + recurring bills)
- Add "Tax Export" (country-specific CSV/JSON templates) at $9/mo add-on
- Consider white-label API for accounting firms (high LTV, low support burden)
- Target: 500 paying users = $3,000–$4,000 MRR

### Unit economics sanity check
| Metric | Target |
|---|---|
| Free → Pro conversion | 5–8% |
| Pro price | $50/yr |
| ARPU (blended) | $4–6/mo |
| CAC (organic + referral) | <$10 (SEA, no paid ads) |
| LTV (24-mo avg) | $100–144 |
| LTV/CAC | >10x at $0 ad spend |
| Supabase + Vercel cost at 500 users | ~$25–50/mo |
| Break-even | 1–2 users (infra ~$0.05/user/mo) |

---

## 3. Single next sprint (2 weeks)

**Goal: Ship the "cashflow forecast + budget + recurring" dashboard so a new user sees value in <5 minutes, then open waitlist.**

| Day | Task | Effort |
|-----|------|--------|
| 1–2 | Cashflow forecast card on DashboardView (engine done, render 6-month chart + "months until broke" badge) | 1–2 days |
| 3–4 | Budget + recurring-bill cards on dashboard (spend-vs-cap bar, next 5 bills list) | 1–2 days |
| 5–6 | Income entry: add "Add Income" button on ExpensesView, pre-fill category=Income | 0.5 days |
| 7–9 | CSV import (expense + income) + CSV export button in Settings | 2 days |
| 10–11 | Landing page (GitHub Pages, $0): waitlist form → Supabase table, 3 value-prop bullets, no sign-up | 1 day |
| 12–14 | Beta: 10 hand-picked users, instrument activation metric, fix top-3 bugs | 2 days |

**Explicitly NOT doing this sprint:** dividends UI, rebalance UI, LLM coach polish, new currencies, OFX import.

---

*Files: /opt/data/omniflow-web/PRODUCT_PLAN.md*
