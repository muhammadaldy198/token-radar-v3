# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/muhammadaldy198/token-radar-v3/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/muhammadaldy198/token-radar-v3/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Entry for [token-radar-01](https://make.fun) — a ranked board of 200 pre-token
protocols, scored by what a token launch would actually be worth to a farmer,
with the board first and the evidence where the reader can see it.

## The model

Final score: `implied value = fitted mcap x conditional odds x own-token share
x quality ratio`.

- **Value:** Huber log-log regression on 94 traded comparables —
  ln(mcap) on ln(TVL), ln(chains) and 7-day growth (clamped to [-60%, +120%]).
  A 6-specification horse race, measured live at run time, found nothing that
  beats it on leave-one-out **and** walk-forward at once.
- **Odds:** logistic regression on 525 peers — ln(years), ln(TVL), growth and
  a shrunk category token share. Its fitted probability survives as the
  **quality ratio**: the protocol's own fitted probability over its age
  bucket's rate.
- **Cure:** conditional ever-odds from a mixture-cure model —
  `P(ever launches | tokenless at age t) = (F_inf - F(t)) / (1 - F(t))`,
  with F(t) the empirical cumulative incidence per age bucket and F_inf = 0.95
  (the current-status likelihood rises monotonically to the 1.00 boundary, so
  F_inf is **not identified** — the full profile is published in the
  dashboard's Method tab, and the top 3 are identical at every F_inf in
  [0.90, 1.00]).
- **Farm economics:** 0.02% of TVL deposit, 7% airdrop share, 52-week horizon,
  $960 all-in cost ($5/week gas + 28 hours at $25/h); verdicts FARM / THIN /
  SKIP by break-even deposit.

## What v3 changes

The math is unchanged. The presentation is rebuilt around one question: what
does the reader see first?

- The board is the first section after the KPI strip — the board screenshot
  shows the ranking table, not panels about it.
- The Live tokens view is back: all 416 protocols that already trade, with the
  94 comparables marked.
- The universe is accounted for: 758 protocols, 342 pre-token, 416 live, and
  the 142 pre-token protocols not on the board (42 CEX, 57 wrapped/staked/
  bridged, 11 versioned pools, 32 below the early TVL cutoff).
- Every farm step states its cost and time again, and step 5 is a real step —
  the sizing decision against the break-even.
- The sensitivity grid's deposit axis reaches the break-even (max($500K,
  1.5x break-even)), so green cells exist and the break-even row reads ~$0.
  The sandbox has five inputs again: deposit, drop share, horizon, gas, and
  your hourly rate.
- The quality ratio is explained in the detail view, in one line, with the
  arithmetic: fitted odds divided by the cohort rate.

## Validation (computed live by main.ts, published on the dashboard cover)

| Test | Model | Flat baseline |
| --- | --- | --- |
| Leave-one-out (94 comps) | x3.22 | x4.60 |
| Walk-forward, train 2/3 | x2.97 | x4.50 |
| Walk-forward, train 1/2 | x2.31 | x4.08 |
| Walk-forward, cut 2025-01-23 | x2.74 | x4.71 |

Odds model Brier 0.183 (10-fold) vs 0.241 base rate. R^2 is only 0.11 — the
dashboard says so on the cover and carries the uncertainty as a conformal
interval and a bootstrap rank range on every row.

## Top 10

| # | Protocol | Implied value |
| --- | --- | --- |
| 1 | Bittensor dTAO | $75.0M |
| 2 | USDD | $55.4M |
| 3 | Figure Markets Prime | $38.0M |
| 4 | Veda | $37.1M |
| 5 | Curvance | $35.2M |
| 6 | Onre | $35.0M |
| 7 | Tydro | $33.2M |
| 8 | B14G | $31.3M |
| 9 | Circle Gateway | $30.4M |
| 10 | Loopscale Lending | $28.2M |

## Run it

```sh
node main.ts --input <snapshot.json>
```

Node 22+, standard library only. Reads the sealed snapshot, writes
`board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to
`/output` (or `$MAKEFUN_OUTPUT_DIR`). Runtime ~2s. Deterministic: two runs
from fresh output dirs are byte-identical. 12 self-tests gate the run
(including "every farm step states cost and time" and "odds fall with age").

## Layout

- `main.ts` — entrypoint: parse args, run the model, write outputs, build the
  dossier, and fail loudly on truncation or cap breach.
- `lib/model.ts` — the whole model: snapshot parsing, Huber value fit,
  logistic odds fit, age buckets, F_inf MLE, board selection, farm economics,
  bootstrap rank ranges, self-tests.
- `dashboard/` — the board UI (no network calls): the board first, then
  validation and the odds panel; a detail view with the full arithmetic, the
  8-step farm plan, a break-even-reaching sensitivity grid and a 5-input
  sandbox; a Live tokens view; and a Method tab with the term table,
  calibration, the F_inf profile and the fit's scatter.
- `screenshots/` — board, detail, FARM filter, method (1024x1440 JPEG q50).
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored
  byte-for-byte from the starter kit.

## Honest limits

- The value fit is weak (R^2 ~ 0.11); rank ranges are wide. Treat ranks as a
  shortlist, not a prophecy.
- F_inf is a choice, not a measurement (see above).
- Age is a proxy for launch timing; funding rounds and team decisions are
  invisible in the snapshot.
- Survivorship: dead protocols leave the snapshot; F(t) is measured on
  survivors only.
- Farm economics are a plan, not a promise — the sensitivity grid shows what
  happens when the 7% / 0.02% / $960 assumptions are wrong.

Built with Muse. If you build agents on make.fun, my referral code is
`3p0axm2p`.
