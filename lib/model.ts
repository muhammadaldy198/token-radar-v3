// Token Radar v3 — the model: one sealed snapshot in, one ranked board out.
//
// The board ranks 200 pre-token protocols by what a launch would be worth to
// a farmer: fitted market cap x conditional launch odds x own-token share x
// quality ratio. Every number the dashboard shows is computed here at run
// time from the snapshot alone — no name is ever special-cased, no figure is
// copied in from a notebook.
//
//   value   Huber log-log on 94 traded comparables:
//           ln(mcap) ~ ln(TVL) + ln(chains) + 7-day growth.
//   odds    Logistic on 525 peers: ln(years) + ln(TVL) + growth +
//           shrunk category token share. Its fitted probability survives as
//           the quality ratio (fitted / age-bucket rate).
//   cure    Mixture-cure conditional odds: P(ever | tokenless at age t) =
//           (F_inf - F(t)) / (1 - F(t)), F(t) empirical per age bucket,
//           F_inf = 0.95 (MLE at the 1.00 boundary, not identified).
//   farm    Plan deposit 0.02% of TVL, 7% airdrop share, 52-week horizon,
//           $960 all-in cost; verdict by break-even deposit.
//
// v3 keeps this math exactly and rebuilds the presentation: the board is the
// first thing on the page, the live-token view is back, farm steps carry
// their cost and time again, and the sensitivity grid reaches break-even.

/** One protocol of the sealed snapshot: exactly its ten fields. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** The snapshot out of a file's text, refused unless it is the shape scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols: Proto[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' ||
        typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------------------
// Features and set definitions (field guide + the validated v1/v2 spec)
// ---------------------------------------------------------------------------

/** The snapshot's date, fixed: ages are measured to 2026-11-14, never to now. */
const AS_OF_MS = Date.parse('2026-11-14T00:00:00Z');
const DAY_MS = 86_400_000;

/** Categories the fits never train on: exchanges and wrapped/staked/bridged. */
const EXCLUDED_CATS = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
/** A name ending in a release marker is a versioned pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Days from listed_at to the snapshot date; null when unreported. */
export function ageDays(p: Proto): number | null {
  if (p.listed_at === null) return null;
  const ms = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((AS_OF_MS - ms) / DAY_MS));
}

/** Age in years (365.25-day years); null when unreported. */
export function ageYears(p: Proto): number | null {
  const d = ageDays(p);
  return d === null ? null : d / 365.25;
}

/** 7-day TVL change as a fraction, clamped to [-0.6, +1.2]. One board row sits
 *  at +4448%; without the clamp the fit explodes. The clamp applies in the
 *  fit AND in prediction (same function), so no row is ever scored off-spec. */
export function g7(p: Proto): number {
  const raw = p.change_7d === null ? 0 : p.change_7d / 100;
  return Math.min(1.2, Math.max(-0.6, raw));
}

/** Records no token: no market cap, no CoinGecko id, no symbol. */
export function isPre(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Rankable on the board: pre-token, not an exchange, name not versioned. */
export function isRankable(p: Proto): boolean {
  return isPre(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/** A wrapped / staked / bridged product of a token that already trades. */
export function isWrapped(p: Proto): boolean {
  if (p.category !== null && EXCLUDED_CATS.has(p.category) && p.category !== 'CEX') return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return EXCHANGE_NAMES.some((e) => p.name === e || p.name.startsWith(`${e} `));
}

/** Value-model comparables: traded, with a market cap, in a usable category. */
export function isComp(p: Proto): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
    p.category !== null && !EXCLUDED_CATS.has(p.category);
}

/** Odds-model peers: any protocol in a usable category. */
export function isPeer(p: Proto): boolean {
  return p.category !== null && !EXCLUDED_CATS.has(p.category);
}

/** The value fit's features: [ln(TVL), ln(chains), g7]. */
export function valueFeatures(p: Proto): number[] {
  return [Math.log(p.tvl_usd), Math.log(Math.max(1, p.chains.length)), g7(p)];
}

// ---------------------------------------------------------------------------
// Small utilities: statistics, a seeded RNG, the logistic function
// ---------------------------------------------------------------------------

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

/** Deterministic RNG (mulberry32): bootstrap and CV folds must be seeded, so
 *  two runs of the entry write the same bytes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Linear algebra: Gaussian elimination with partial pivoting (stdlib only)
// ---------------------------------------------------------------------------

/** Solve A x = b, or null when A is (near-)singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** A design matrix: an intercept column in front of the features. */
function withIntercept(X: number[][]): number[][] {
  return X.map((row) => [1, ...row]);
}

/** Weighted least squares through the normal equations. */
function wls(Xd: number[][], y: number[], w: number[]): number[] | null {
  const k = Xd[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < Xd.length; i++) {
    const xi = Xd[i]!;
    for (let r = 0; r < k; r++) {
      b[r] += w[i]! * xi[r]! * y[i]!;
      for (let c = 0; c < k; c++) A[r]![c]! += w[i]! * xi[r]! * xi[c]!;
    }
  }
  return solveLinear(A, b);
}

/** Huber regression by IRLS (c = 1.345, MAD scale, OLS start). */
export function huberFit(X: number[][], y: number[], c = 1.345, iters = 50): { beta: number[]; converged: boolean } {
  const Xd = withIntercept(X);
  let beta = wls(Xd, y, new Array<number>(y.length).fill(1)) ?? new Array<number>(Xd[0]!.length).fill(0);
  let converged = false;
  for (let it = 0; it < iters; it++) {
    const resid = y.map((yi, i) => yi - Xd[i]!.reduce((s, x, j) => s + x * beta[j]!, 0));
    const med = median(resid);
    const s = 1.4826 * median(resid.map((r) => Math.abs(r - med))) + 1e-9;
    const w = resid.map((r) => {
      const u = Math.abs(r / (c * s));
      return u <= 1 ? 1 : 1 / u;
    });
    const nb = wls(Xd, y, w);
    if (nb === null) break;
    const shift = Math.max(...nb.map((v, j) => Math.abs(v - beta[j]!)));
    beta = nb;
    if (shift < 1e-10) {
      converged = true;
      break;
    }
  }
  return { beta, converged };
}

/** Plain OLS through the same normal equations. */
export function olsFit(X: number[][], y: number[]): number[] {
  const Xd = withIntercept(X);
  return wls(Xd, y, new Array<number>(y.length).fill(1)) ?? new Array<number>(Xd[0]!.length).fill(0);
}

/** One prediction: intercept + dot(beta[1:], x). */
export function predictRow(beta: number[], x: number[]): number {
  let s = beta[0]!;
  for (let j = 0; j < x.length; j++) s += beta[j + 1]! * x[j]!;
  return s;
}

/** Logistic regression by Newton IRLS. The ridge penalty is applied ONCE,
 *  AFTER the per-row gradient loop — applying it inside the loop multiplies
 *  it by n (v1's ridge bug: effective ridge 0.0525 instead of 1e-4, caught
 *  by an independent re-fit). */
export function logisticFit(X: number[][], y: number[], ridge = 1e-4, iters = 100): { beta: number[]; converged: boolean } {
  const Xd = withIntercept(X);
  const k = Xd[0]!.length;
  const beta = new Array<number>(k).fill(0);
  let converged = false;
  for (let it = 0; it < iters; it++) {
    const grad = new Array<number>(k).fill(0);
    const H: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < Xd.length; i++) {
      const xi = Xd[i]!;
      let z = 0;
      for (let j = 0; j < k; j++) z += xi[j]! * beta[j]!;
      const p = sigmoid(z);
      const w = p * (1 - p) + 1e-9;
      const r = y[i]! - p;
      for (let a = 0; a < k; a++) {
        grad[a] += xi[a]! * r;
        for (let b = 0; b < k; b++) H[a]![b]! += w * xi[a]! * xi[b]!;
      }
    }
    // Ridge applied once, outside the row loop.
    for (let a = 0; a < k; a++) {
      grad[a] -= ridge * beta[a]!;
      H[a]![a]! += ridge;
    }
    const step = solveLinear(H, grad);
    if (step === null) break;
    let shift = 0;
    for (let j = 0; j < k; j++) {
      beta[j] += step[j]!;
      shift = Math.max(shift, Math.abs(step[j]!));
    }
    if (shift < 1e-8) {
      converged = true;
      break;
    }
  }
  return { beta, converged };
}

// ---------------------------------------------------------------------------
// Value model: Huber log-log on the comparables.
// ln(mcap) ~ 1 + ln(TVL) + ln(chains) + g7. Locked by the horse race: nothing
// beat it on leave-one-out AND walk-forward at once.
// ---------------------------------------------------------------------------

export interface ValueFit {
  beta: number[];
  converged: boolean;
  loo: number; // median multiplicative miss, leave-one-out
  looFlat: number; // same, flat global median multiple
  wf: number[]; // 3 walk-forward splits, median miss each
  wfFlat: number[];
  r2: number;
  n: number;
  looResiduals: number[]; // signed log residuals, LOO (for the conformal band)
}

/** The three walk-forward splits over dated comparables: train 2/3, train
 *  1/2, and a fixed calendar cut at 2025-01-23. */
function wfSplits(comps: Proto[]): Array<[number[], number[]]> {
  const dated = comps.map((p, i) => ({ p, i })).filter(({ p }) => p.listed_at !== null);
  dated.sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const idx = dated.map(({ i }) => i);
  return [
    [idx.slice(0, Math.floor((idx.length * 2) / 3)), idx.slice(Math.floor((idx.length * 2) / 3))],
    [idx.slice(0, Math.floor(idx.length / 2)), idx.slice(Math.floor(idx.length / 2))],
    [
      idx.filter((i) => comps[i]!.listed_at! < '2025-01-23'),
      idx.filter((i) => comps[i]!.listed_at! >= '2025-01-23'),
    ],
  ];
}

export function fitValue(comps: Proto[]): ValueFit {
  const X = comps.map(valueFeatures);
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const { beta, converged } = huberFit(X, y);

  // Leave-one-out: refit without each comp, measure its miss.
  const looResid: number[] = [];
  const looMiss: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const b = huberFit(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i)).beta;
    const e = y[i]! - predictRow(b, X[i]!);
    looResid.push(e);
    looMiss.push(Math.exp(Math.abs(e)));
  }
  const loo = median(looMiss);

  // Flat baseline LOO (global median mcap/TVL multiple).
  const ratios = comps.map((p) => p.mcap_usd! / p.tvl_usd);
  const flatMiss: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const m = median(ratios.filter((_, j) => j !== i));
    flatMiss.push(Math.exp(Math.abs(Math.log(comps[i]!.mcap_usd!) - Math.log(m * comps[i]!.tvl_usd))));
  }
  const looFlat = median(flatMiss);

  // Walk-forward, same splits as the term table; flat baseline alongside.
  const wf: number[] = [];
  const wfFlat: number[] = [];
  for (const [tr, te] of wfSplits(comps)) {
    const b = huberFit(tr.map((j) => X[j]!), tr.map((j) => y[j]!)).beta;
    wf.push(median(te.map((j) => Math.exp(Math.abs(y[j]! - predictRow(b, X[j]!))))));
    const m = median(tr.map((j) => ratios[j]!));
    wfFlat.push(median(te.map((j) => Math.exp(Math.abs(Math.log(comps[j]!.mcap_usd!) - Math.log(m * comps[j]!.tvl_usd))))));
  }

  const pred = X.map((x) => predictRow(beta, x));
  const ssRes = y.reduce((s, yi, i) => s + (yi - pred[i]!) ** 2, 0);
  const yMean = mean(y);
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  return { beta, converged, loo, looFlat, wf, wfFlat, r2: 1 - ssRes / ssTot, n: comps.length, looResiduals: looResid };
}

// ---------------------------------------------------------------------------
// Term table: the shipped spec against its rivals, measured here at run time.
// A rival ships only when it beats the shipped spec on LOO AND walk-forward.
// ---------------------------------------------------------------------------

export interface TermRow {
  spec: string;
  loo: number;
  wfAvg: number;
  ship: boolean;
}

export function termTable(comps: Proto[], shipped: ValueFit): TermRow[] {
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const splits = wfSplits(comps);
  type FeatFn = (p: Proto) => number[];
  const specs: Array<{ spec: string; fn: FeatFn; fit: 'huber' | 'ols' }> = [
    { spec: 'Huber [lnTVL, lnChains, g7] (shipped)', fn: valueFeatures, fit: 'huber' },
    { spec: 'OLS [lnTVL, lnChains, g7]', fn: valueFeatures, fit: 'ols' },
    {
      spec: 'Huber + age',
      fn: (p) => [...valueFeatures(p), Math.log(Math.max(1, ageDays(p) ?? 365) / 365)],
      fit: 'huber',
    },
    { spec: 'Huber [lnTVL, g7] (drop chains)', fn: (p) => [Math.log(p.tvl_usd), g7(p)], fit: 'huber' },
    {
      spec: 'Huber + lnTVL^2',
      fn: (p) => [...valueFeatures(p), Math.log(p.tvl_usd) ** 2],
      fit: 'huber',
    },
    { spec: 'OLS [lnTVL] only (Firstlight)', fn: (p) => [Math.log(p.tvl_usd)], fit: 'ols' },
  ];
  const rows: TermRow[] = [];
  for (const s of specs) {
    const X = comps.map(s.fn);
    const fitFn = (Xtr: number[][], ytr: number[]) =>
      s.fit === 'huber' ? huberFit(Xtr, ytr).beta : olsFit(Xtr, ytr);
    const misses: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const b = fitFn(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i));
      misses.push(Math.exp(Math.abs(y[i]! - predictRow(b, X[i]!))));
    }
    const loo = median(misses);
    const wfAvgs: number[] = [];
    for (const [tr, te] of splits) {
      const b = fitFn(tr.map((j) => X[j]!), tr.map((j) => y[j]!));
      wfAvgs.push(median(te.map((j) => Math.exp(Math.abs(y[j]! - predictRow(b, X[j]!))))));
    }
    const wfAvg = mean(wfAvgs);
    const isShipped = s.spec.includes('(shipped)');
    rows.push({ spec: s.spec, loo, wfAvg, ship: isShipped || (loo < shipped.loo && wfAvg < mean(shipped.wf)) });
  }
  // Flat baseline row (no fit at all).
  const ratios = comps.map((p) => p.mcap_usd! / p.tvl_usd);
  const flatMiss: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const m = median(ratios.filter((_, j) => j !== i));
    flatMiss.push(Math.exp(Math.abs(Math.log(comps[i]!.mcap_usd!) - Math.log(m * comps[i]!.tvl_usd))));
  }
  rows.push({ spec: 'Flat global median multiple', loo: median(flatMiss), wfAvg: mean(shipped.wfFlat), ship: false });
  return rows;
}

// ---------------------------------------------------------------------------
// Odds model: logistic on the peers. Label = records a token.
// Features: ln(years), ln(TVL), g7, shrunk category token share (k=10).
// ---------------------------------------------------------------------------

export interface OddsFit {
  beta: number[];
  converged: boolean;
  brier: number; // 10-fold, seeded folds
  brierBase: number; // base-rate Brier
  baseRate: number;
  catShare: Map<string, number>;
  n: number;
}

export function oddsFeatures(p: Proto, catShare: Map<string, number>, baseRate: number): number[] {
  const a = ageDays(p);
  return [
    Math.log(Math.max(1, a ?? 365) / 365),
    Math.log(p.tvl_usd),
    g7(p),
    catShare.get(p.category ?? '') ?? baseRate,
  ];
}

export function fitOdds(peers: Proto[]): OddsFit {
  const y = peers.map((p) => (isPre(p) ? 0 : 1));
  const baseRate = mean(y);
  // Category token share, shrunk toward the base rate (k = 10 pseudo-counts):
  // a category with 2 protocols does not get to claim a 0% or 100% rate.
  const tot = new Map<string, number>();
  const cnt = new Map<string, number>();
  for (let i = 0; i < peers.length; i++) {
    const c = peers[i]!.category!;
    tot.set(c, (tot.get(c) ?? 0) + y[i]!);
    cnt.set(c, (cnt.get(c) ?? 0) + 1);
  }
  const catShare = new Map<string, number>();
  for (const [c, t] of tot) catShare.set(c, (t + 10 * baseRate) / (cnt.get(c)! + 10));

  const X = peers.map((p) => oddsFeatures(p, catShare, baseRate));
  const { beta, converged } = logisticFit(X, y);

  // 10-fold Brier with seeded folds (mulberry32, seed 42).
  const rng = mulberry32(42);
  const perm = peers.map((_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  const foldSize = Math.ceil(peers.length / 10);
  const briers: number[] = [];
  for (let f = 0; f < 10; f++) {
    const te = new Set(perm.slice(f * foldSize, (f + 1) * foldSize));
    const tr = perm.filter((i) => !te.has(i));
    const b = logisticFit(tr.map((j) => X[j]!), tr.map((j) => y[j]!)).beta;
    let sse = 0;
    for (const j of te) {
      const pr = sigmoid(predictRow(b, X[j]!));
      sse += (pr - y[j]!) ** 2;
    }
    briers.push(sse / te.size);
  }
  return { beta, converged, brier: mean(briers), brierBase: baseRate * (1 - baseRate), baseRate, catShare, n: peers.length };
}

/** Cumulative launch probability P(has token | features) — the v1 odds. */
export function pCum(p: Proto, odds: OddsFit): number {
  return sigmoid(predictRow(odds.beta, oddsFeatures(p, odds.catShare, odds.baseRate)));
}

/** 12-month hazard odds from the same logistic: P(tokens within 12m |
 *  tokenless at age t) = (p(age+365d) - p(age)) / (1 - p(age)). The farm
 *  economics run on this, not on the ever-odds. */
export function odds12m(p: Proto, odds: OddsFit): number {
  const p0 = pCum(p, odds);
  if (p0 >= 1) return 0;
  const a = ageDays(p);
  const a2 = (a ?? 365) + 365;
  const f = [
    Math.log(Math.max(1, a2) / 365),
    Math.log(p.tvl_usd),
    g7(p),
    odds.catShare.get(p.category ?? '') ?? odds.baseRate,
  ];
  const p1 = sigmoid(predictRow(odds.beta, f));
  return Math.max(0, (p1 - p0) / (1 - p0));
}

/** Calibration buckets: mean predicted vs actual token rate per band. */
export interface CalBucket {
  lo: number;
  hi: number;
  n: number;
  pred: number;
  actual: number;
}

export function calibration(peers: Proto[], odds: OddsFit): CalBucket[] {
  const bands: Array<[number, number]> = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
  return bands.map(([lo, hi]) => {
    const sel = peers.filter((p) => {
      const pr = pCum(p, odds);
      return pr >= lo && pr < hi;
    });
    if (sel.length === 0) return { lo, hi, n: 0, pred: NaN, actual: NaN };
    const pred = mean(sel.map((p) => pCum(p, odds)));
    const actual = mean(sel.map((p) => (isPre(p) ? 0 : 1)));
    return { lo, hi, n: sel.length, pred, actual };
  });
}

/** Conformal 50% band from the LOO residuals: half-width = median |residual|,
 *  plus the measured coverage of that band on the comparables. */
export function conformalBand(value: ValueFit): { halfWidth: number; coverage: number } {
  const halfWidth = median(value.looResiduals.map((r) => Math.abs(r)));
  const covered = value.looResiduals.filter((r) => Math.abs(r) <= halfWidth).length;
  return { halfWidth, coverage: covered / value.looResiduals.length };
}

// ---------------------------------------------------------------------------
// Conditional ever-odds from a mixture-cure model.
// P(ever | tokenless at age t) = (F_inf - F(t)) / (1 - F(t)).
// ---------------------------------------------------------------------------

export interface AgeBucket {
  lo: number; // years
  hi: number; // years (99 = open-ended)
  n: number;
  tokened: number;
  f: number; // cumulative incidence F(t) in the bucket
  pCond: number; // P(ever | tokenless at this age)
}

/** Empirical age buckets from the peers, pooled from the top down until every
 *  bucket holds >= 10 protocols. Pooling matters: the raw 5y+ bucket holds
 *  only 6 protocols at 67% — below the 4-5y bucket's 93% — which would make
 *  conditional odds RISE again past 5 years. Pooled 4y+ (n=49, 89.8%) keeps
 *  the curve monotone, as the cure model requires. */
export function ageBuckets(peers: Proto[], fInf: number): AgeBucket[] {
  const edges: Array<[number, number]> = [[0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 99]];
  const raw: Array<{ lo: number; hi: number; n: number; tokened: number }> = edges.map(([lo, hi]) => {
    const sel = peers.filter((p) => {
      const a = ageYears(p);
      return a !== null && a >= lo && a < hi;
    });
    return { lo, hi, n: sel.length, tokened: sel.filter((p) => !isPre(p)).length };
  });
  while (raw.length >= 2 && raw[raw.length - 1]!.n < 10) {
    const top = raw.pop()!;
    const prev = raw[raw.length - 1]!;
    prev.hi = top.hi;
    prev.n += top.n;
    prev.tokened += top.tokened;
  }
  return raw.map((b) => {
    const f = b.n === 0 ? NaN : b.tokened / b.n;
    const pCond = f >= fInf ? 0.02 : (fInf - f) / (1 - f);
    return { lo: b.lo, hi: b.hi, n: b.n, tokened: b.tokened, f, pCond };
  });
}

/** A protocol's age bucket's F(t); the cohort base rate when age is unknown. */
export function bucketF(age: number | null, buckets: AgeBucket[], baseRate: number): number {
  if (age === null) return baseRate;
  for (const b of buckets) if (age >= b.lo && age < b.hi) return b.f;
  return buckets[buckets.length - 1]!.f;
}

/** The conditional ever-odds for one age, floored at 2% when the bucket's
 *  incidence already reaches F_inf. */
export function condOdds(age: number | null, buckets: AgeBucket[], baseRate: number, fInf: number): number {
  const f = bucketF(age, buckets, baseRate);
  if (f >= fInf) return 0.02;
  return (fInf - f) / (1 - f);
}

/** F_inf by current-status MLE: each peer contributes F(t) if tokened,
 *  1 - F(t) if not, with F(t) = F_inf * G(t) and G a logistic curve in
 *  ln(years). Grid over F_inf in [0.85, 1.00]; the profile is reported whole
 *  because the data barely identifies F_inf (the profile rises monotonically
 *  to the 1.00 boundary, only ~1 loglik unit above 0.95). The point estimate
 *  0.95 is the midpoint of the honest range [0.90, 1.00]. */
export interface FinfProfile {
  grid: Array<{ fInf: number; loglik: number }>;
  mle: number;
  point: number;
}

export function fitFinf(peers: Proto[]): FinfProfile {
  const aged = peers
    .map((p) => ({ t: ageYears(p), y: isPre(p) ? 0 : 1 }))
    .filter((r) => r.t !== null) as Array<{ t: number; y: number }>;
  const X = aged.map((r) => [1, Math.log(Math.max(1, r.t * 365.25) / 365.25)]);
  const grid: Array<{ fInf: number; loglik: number }> = [];
  for (let k = 0; k <= 15; k++) {
    const fInf = 0.85 + 0.01 * k;
    // Newton on (a, b) for G(t) = sigmoid(a + b*ln_years), F = fInf * G.
    // The Hessian comes from finite differences on the gradient.
    let th = [0, 0.7];
    const gradAt = (t: number[]): number[] => {
      const grad = [0, 0];
      for (let i = 0; i < aged.length; i++) {
        const g = sigmoid(X[i]![0]! * t[0]! + X[i]![1]! * t[1]!);
        const F = Math.min(1 - 1e-9, Math.max(1e-9, fInf * g));
        const w = (aged[i]!.y / F - (1 - aged[i]!.y) / (1 - F)) * fInf * g * (1 - g);
        grad[0] += w * X[i]![0]!;
        grad[1] += w * X[i]![1]!;
      }
      return grad;
    };
    for (let it = 0; it < 60; it++) {
      const grad = gradAt(th);
      const eps = 1e-5;
      const H = [[0, 0], [0, 0]];
      for (let j = 0; j < 2; j++) {
        const th2 = [...th];
        th2[j]! += eps;
        const grad2 = gradAt(th2);
        H[0]![j] = (grad2[0]! - grad[0]!) / eps;
        H[1]![j] = (grad2[1]! - grad[1]!) / eps;
      }
      const step = solveLinear(H, grad);
      if (step === null) break;
      th = [th[0]! - step[0]!, th[1]! - step[1]!];
      if (Math.max(Math.abs(step[0]!), Math.abs(step[1]!)) < 1e-8) break;
    }
    let ll = 0;
    for (let i = 0; i < aged.length; i++) {
      const g = sigmoid(X[i]![0]! * th[0]! + X[i]![1]! * th[1]!);
      const F = Math.min(1 - 1e-9, Math.max(1e-9, fInf * g));
      ll += aged[i]!.y * Math.log(F) + (1 - aged[i]!.y) * Math.log(1 - F);
    }
    grid.push({ fInf, loglik: ll });
  }
  const mle = grid.reduce((best, g) => (g.loglik > best.loglik ? g : best), grid[0]!).fInf;
  return { grid, mle, point: 0.95 };
}

// ---------------------------------------------------------------------------
// Board: 40 watchlist + 140 early (below floor, most TVL) + 20 off-list
// (above floor, not on the watchlist, passes the wrapped/staked/bridged test).
// ---------------------------------------------------------------------------

export interface BoardPick {
  board: Proto[];
  early: number;
  offList: number;
  /** The pre-token protocols NOT on the board, accounted for by reason. */
  ledger: { cex: number; wrapped: number; versioned: number; below_cutoff: number };
}

export function selectBoard(snap: Snapshot): BoardPick {
  const watch = new Set(snap.watchlist);
  const floor = snap.floor_usd;
  const below = snap.protocols
    .filter((p) => isRankable(p) && !watch.has(p.slug) && p.tvl_usd < floor)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const early = below.slice(0, 140);
  const off = snap.protocols
    .filter((p) => isRankable(p) && !isWrapped(p) && p.tvl_usd >= floor && !watch.has(p.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 20);
  const board = [...snap.protocols.filter((p) => watch.has(p.slug)), ...early, ...off];
  // Ledger: every pre-token protocol the board leaves out, by reason, in one
  // order so the counts add up (CEX first, then wrapped, then versioned).
  const onBoard = new Set(board.map((p) => p.slug));
  const rest = snap.protocols.filter((p) => isPre(p) && !onBoard.has(p.slug));
  const ledger = { cex: 0, wrapped: 0, versioned: 0, below_cutoff: 0 };
  for (const p of rest) {
    if (p.category === 'CEX') ledger.cex++;
    else if (isWrapped(p)) ledger.wrapped++;
    else if (VERSIONED_NAME.test(p.name)) ledger.versioned++;
    else ledger.below_cutoff++;
  }
  return { board, early: early.length, offList: off.length, ledger };
}

/** Own-token share: the protocol's TVL over its family stem's TVL (kin = the
 *  tokened protocols sharing the first slug segment). A launch's airdrop only
 *  covers this protocol's own share of the family. */
export function ownShare(p: Proto, snap: Snapshot): number {
  const stem = p.slug.split('-')[0];
  let kinTvl = 0;
  for (const q of snap.protocols) {
    if (q.slug !== p.slug && !isPre(q) && q.slug.split('-')[0] === stem) kinTvl += q.tvl_usd;
  }
  return kinTvl === 0 ? 1 : p.tvl_usd / (p.tvl_usd + kinTvl);
}

// ---------------------------------------------------------------------------
// Farm economics: plan deposit 0.02% of TVL, airdrop 7% of the fitted value,
// horizon 52 weeks. The all-in cost is DERIVED from its parts — $5/week gas
// plus 2 setup hours and half an hour a week at $25/h — so the dashboard's
// sandbox and the model's verdicts share one source of truth ($960).
// Verdict by the break-even deposit a reader would need: FARM <= $100K,
// THIN <= $500K, else SKIP.
// ---------------------------------------------------------------------------

export const FARM = {
  depositFrac: 0.0002,
  dropShare: 0.07,
  horizonWeeks: 52,
  gasPerWeekUsd: 5,
  setupHours: 2,
  hoursPerWeek: 0.5,
  hourlyRateUsd: 25,
};

/** The all-in cost of farming one row for the full horizon. */
export function farmCostUsd(farm: typeof FARM = FARM): number {
  const hours = farm.setupHours + farm.hoursPerWeek * farm.horizonWeeks;
  return farm.gasPerWeekUsd * farm.horizonWeeks + hours * farm.hourlyRateUsd;
}

export interface FarmMath {
  deposit: number;
  expDrop: number;
  breakEven: number; // Infinity when no size breaks even
  verdict: string;
}

export function farmMath(fitMcap: number, share: number, o12: number, tvl: number): FarmMath {
  const deposit = FARM.depositFrac * tvl;
  const expDrop = fitMcap * share * FARM.dropShare * FARM.depositFrac * o12;
  const denom = fitMcap * share * FARM.dropShare * o12;
  const breakEven = denom > 0 ? (farmCostUsd() * tvl) / denom : Infinity;
  const verdict = breakEven <= 100_000 ? 'FARM' : breakEven <= 500_000 ? 'THIN' : 'SKIP';
  return { deposit, expDrop, breakEven, verdict };
}

/** Compact money: $1.2B / $3.4M / $12K / $960. */
function money(n: number): string {
  if (!Number.isFinite(n)) return 'no size breaks even';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** A step as one string: the action, then its cost and time, within the
 *  gate's 20..600 characters. Every step carries both — a plan that hides
 *  what it costs is a slogan, not a plan. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text}. Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The category's one action, in words a farmer can follow. */
function catAction(p: Proto): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lending')) return 'supply the deposit as collateral, then borrow up to 40% of it in a stablecoin and re-supply the loan — the loop is what the points program counts, and keep the health factor above 1.5';
  if (c.includes('dex')) return 'add the deposit as liquidity to the deepest pool on the protocol (ideally a volatile/stable pair), then stake the LP receipt in the protocol’s gauge if one exists';
  if (c.includes('yield')) return 'deposit into the highest-TVL vault and enable auto-compounding; check the vault’s strategy page weekly because allocations rotate';
  if (c.includes('restak')) return 'restake the deposit through the protocol’s operator set and delegate to an operator with >95% uptime; restaked positions usually cannot be exited for 7+ days';
  if (c.includes('derivat')) return 'open a small hedged position (long spot vs short perps, or a basis trade) so the deposit earns funding while the points accrue; size it so a 20% move cannot liquidate it';
  if (c.includes('stable')) return 'mint or hold the protocol’s stablecoin with the deposit and stake it in the savings module; the peg history matters more than the headline APY';
  if (c.includes('rwa')) return 'complete the protocol’s KYC/allowlist step first (RWA vaults usually gate it), then subscribe to the tokenized-asset vault and hold to the stated maturity';
  if (c.includes('bridge') || c.includes('cross')) return 'route the deposit through the protocol’s bridge in 2–3 tranches over separate weeks — bridging volume over time is what these programs reward, not one lump';
  return 'use the protocol’s core product with the deposit (its main pool, vault or market) and hold the position — the points program counts time-weighted exposure, not one-off volume';
}

/**
 * A protocol's farm plan: eight concrete steps, each an action with a cost
 * and a time, templated from the row's own numbers (deposit, chain, category,
 * horizon, break-even). Step 5 is a real step — the sizing decision — not a
 * comment: it tells the reader to compare the plan deposit against the
 * break-even before committing capital.
 */
export function farmSteps(p: Proto, row: { deposit: number; expDrop: number; breakEven: number; verdict: string }): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const dep = money(row.deposit);
  const be = money(row.breakEven);
  const cost = money(farmCostUsd());
  const action = catAction(p);
  const actionCap = action.charAt(0).toUpperCase() + action.slice(1);
  return [
    stepText(
      `Set up a fresh wallet on ${chain} and fund it with ${dep} plus about $30 for gas — ${chain} transactions run roughly $1–8 each, so keep a gas buffer and never deposit your last dollars`,
      'about $30 of gas',
      '10 minutes',
    ),
    stepText(
      `Bridge or swap the ${dep} into the asset ${p.name} accepts (usually the chain’s native token or a major stablecoin); allow the bridge to finalize and verify the receipt on-chain`,
      'about $4–8 of gas and bridge fees',
      '10–20 minutes',
    ),
    stepText(
      `${actionCap} — this is the position that earns points, and it should stay open for the full ${FARM.horizonWeeks}-week horizon`,
      `${dep} of capital and about $8 of gas`,
      '15 minutes to set up',
    ),
    stepText(
      `Record the position: screenshot the deposit receipt, note the transaction hash and the pool address, and set a calendar check every Sunday — points programs change rules mid-season and early farmers get cut for missing a step`,
      'nothing but the log',
      '10 minutes',
    ),
    stepText(
      `Size-check the plan before you commit: at the ${dep} plan deposit the expected airdrop is about ${money(row.expDrop)} against a ${cost} all-in cost, and the break-even deposit is ${be} — if your deposit is below break-even, either size up toward ${be} or cap the farm at money you can lose`,
      'nothing but the decision',
      '10 minutes',
    ),
    stepText(
      `Keep the position through at least one full points epoch (usually 4–8 weeks) before judging it — most programs weight time in the pool, and early exits forfeit the multiplier`,
      'about $5 of gas a week',
      '30 minutes a week',
    ),
    stepText(
      `Watch for the token announcement on the protocol’s official channels only; when it lands, check eligibility with the same wallet that farmed, and claim within the stated window (unclaimed drops usually expire in 30–90 days)`,
      'claim gas, about $5–15',
      '10 minutes',
    ),
    stepText(
      `Exit on a plan, not a feeling: if the token launches, sell enough to cover the ${cost} cost first, then decide on the rest; if no token appears within the ${FARM.horizonWeeks}-week horizon, withdraw and redeploy to the next row on this board`,
      'about $5 of exit gas',
      '15 minutes',
    ),
  ];
}

// ---------------------------------------------------------------------------
// Bootstrap rank ranges: 200 resamples of the comparables, value refit each
// time, ranks recomputed with the resampled value beta (odds held fixed —
// the value fit is the dominant uncertainty). Seeded, so runs are identical.
// ---------------------------------------------------------------------------

export function bootstrapRanges(
  comps: Proto[],
  boardRows: Array<{ slug: string; fitX: number[]; mult: number }>,
  rounds = 200,
): Map<string, [number, number]> {
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const X = comps.map(valueFeatures);
  const rng = mulberry32(20261124);
  const ranks = new Map<string, number[]>();
  for (const r of boardRows) ranks.set(r.slug, []);
  for (let b = 0; b < rounds; b++) {
    const idx: number[] = [];
    for (let i = 0; i < comps.length; i++) idx.push(Math.floor(rng() * comps.length));
    const beta = huberFit(idx.map((j) => X[j]!), idx.map((j) => y[j]!)).beta;
    const evs = boardRows.map((r) => ({ slug: r.slug, ev: Math.exp(predictRow(beta, r.fitX)) * r.mult }));
    evs.sort((a, b2) => b2.ev - a.ev || (a.slug < b2.slug ? -1 : 1));
    evs.forEach((e, i) => ranks.get(e.slug)!.push(i + 1));
  }
  const out = new Map<string, [number, number]>();
  for (const [slug, rs] of ranks) out.set(slug, [Math.min(...rs), Math.max(...rs)]);
  return out;
}

// ---------------------------------------------------------------------------
// Assembly: buildRadar runs the whole model and returns the board + the radar
// object the dashboard renders. Every evidence number is computed here.
// ---------------------------------------------------------------------------

/** One row of board.json: the ranked board's row, with the extra keys the
 *  gate allows and the dashboard reads. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  tvl_usd: number;
  category: string | null;
  chains: string[];
  g7: number; // 7-day growth, clamped — lets the dashboard refit the row's value
  age_years: number | null;
  fit_mcap_usd: number;
  odds_cum: number;
  odds_cond: number;
  odds_12m: number;
  own_share: number;
  quality_ratio: number;
  bucket_f: number; // the age bucket's F(t) the quality ratio divides by
  interval_lo_usd: number;
  interval_hi_usd: number;
  rank_lo: number;
  rank_hi: number;
  verdict: string;
  plan_deposit_usd: number;
  exp_drop_usd: number;
  break_even_usd: number | null;
  on_watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's
 *  own value, never a model's. The 94 in the fit are marked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  in_fit: boolean;
}

/** Everything the dashboard needs, computed from the snapshot. */
export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  total_protocols: number;
  pre_token: number;
  live_total: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  off_list_size: number;
  ledger: { cex: number; wrapped: number; versioned: number; below_cutoff: number };
  value: { beta: number[]; loo: number; loo_flat: number; wf: number[]; wf_flat: number[]; r2: number; n: number; converged: boolean };
  odds: { beta: number[]; brier: number; brier_base: number; base_rate: number; n: number; converged: boolean };
  buckets: AgeBucket[];
  finf: FinfProfile;
  finf_sensitivity: Array<{ f_inf: number; top3: string[]; overlap_top20: number }>;
  term_table: TermRow[];
  calibration: CalBucket[];
  conformal: { half_width: number; coverage: number };
  farm: { deposit_frac: number; drop_share: number; horizon_weeks: number; gas_per_week_usd: number; setup_hours: number; hours_per_week: number; hourly_rate_usd: number; cost_usd: number };
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  scatter: { points: Array<{ x: number; y: number }>; line: Array<{ x: number; y: number }>; band: number };
  rows: BoardRow[];
  live: LiveRow[];
  watchlist_slugs: string[];
  self_test: Array<{ name: string; pass: boolean; detail: string }>;
}

export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: Radar } {
  const comps = snap.protocols.filter(isComp);
  const peers = snap.protocols.filter(isPeer);
  const value = fitValue(comps);
  const odds = fitOdds(peers);
  const terms = termTable(comps, value);
  const cal = calibration(peers, odds);
  const band = conformalBand(value);
  const finf = fitFinf(peers);
  const buckets = ageBuckets(peers, finf.point);
  const { board, early, offList, ledger } = selectBoard(snap);

  // Rows: EV = fitted mcap x conditional odds x own share x quality ratio.
  const rows: BoardRow[] = board.map((p) => {
    const fit = Math.exp(predictRow(value.beta, valueFeatures(p)));
    const sh = ownShare(p, snap);
    const pc = pCum(p, odds);
    const age = ageYears(p);
    const fb = bucketF(age, buckets, odds.baseRate);
    const pcond = condOdds(age, buckets, odds.baseRate, finf.point);
    const qr = pc / Math.max(fb, 0.05);
    const ev = fit * sh * pcond * qr;
    const o12 = odds12m(p, odds);
    const fm = farmMath(fit, sh, o12, p.tvl_usd);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0, // assigned after sorting
      implied_value_usd: Math.max(1, Math.round(ev)),
      farm_steps: farmSteps(p, fm),
      tvl_usd: p.tvl_usd,
      category: p.category,
      chains: p.chains,
      g7: g7(p),
      age_years: age,
      fit_mcap_usd: Math.max(1, Math.round(fit)),
      odds_cum: pc,
      odds_cond: pcond,
      odds_12m: o12,
      own_share: sh,
      quality_ratio: qr,
      bucket_f: fb,
      interval_lo_usd: Math.max(1, Math.round(fit * Math.exp(-band.halfWidth))),
      interval_hi_usd: Math.max(1, Math.round(fit * Math.exp(band.halfWidth))),
      rank_lo: 0,
      rank_hi: 0,
      verdict: fm.verdict,
      plan_deposit_usd: Math.round(fm.deposit),
      exp_drop_usd: Math.round(fm.expDrop * 100) / 100,
      break_even_usd: Number.isFinite(fm.breakEven) ? Math.round(fm.breakEven) : null,
      on_watchlist: snap.watchlist.includes(p.slug),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => (r.rank = i + 1));

  // Bootstrap rank ranges (value-model uncertainty only).
  const bySlug = new Map(board.map((p) => [p.slug, p]));
  const ranges = bootstrapRanges(
    comps,
    rows.map((r) => ({
      slug: r.slug,
      fitX: valueFeatures(bySlug.get(r.slug)!),
      mult: r.own_share * r.odds_cond * r.quality_ratio,
    })),
  );
  for (const r of rows) {
    const [lo, hi] = ranges.get(r.slug)!;
    r.rank_lo = lo;
    r.rank_hi = hi;
  }

  // F_inf sensitivity: rebuild the top 20 at five F_inf values. Overlap is
  // measured against the point estimate's own top 20, not against any older
  // version's — this entry stands on its own numbers.
  const top20At = (f: number): string[] => {
    const scored = board.map((p) => {
      const fit = Math.exp(predictRow(value.beta, valueFeatures(p)));
      const sh = ownShare(p, snap);
      const pc = pCum(p, odds);
      const age = ageYears(p);
      const fb = bucketF(age, buckets, odds.baseRate);
      const pcond = f >= 1 ? 1 : fb >= f ? 0.02 : (f - fb) / (1 - fb);
      return { slug: p.slug, ev: fit * sh * pcond * (pc / Math.max(fb, 0.05)) };
    });
    scored.sort((a, b) => b.ev - a.ev || (a.slug < b.slug ? -1 : 1));
    return scored.slice(0, 20).map((s) => s.slug);
  };
  const pointTop20 = new Set(top20At(finf.point));
  const finfSensitivity = [0.9, 0.93, 0.95, 0.98, 1.0].map((f) => {
    const top20 = top20At(f);
    return { f_inf: f, top3: top20.slice(0, 3), overlap_top20: top20.filter((s) => pointTop20.has(s)).length };
  });

  // Cover scatter: the 94 comparables (ln TVL vs ln mcap) plus the Huber line
  // evaluated at the median chain count and median g7, with the conformal band.
  const medChains = median(comps.map((p) => Math.log(Math.max(1, p.chains.length))));
  const medG7 = median(comps.map((p) => g7(p)));
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const line: Array<{ x: number; y: number }> = [];
  for (let k = 0; k <= 20; k++) {
    const x = lo + ((hi - lo) * k) / 20;
    line.push({ x, y: value.beta[0]! + value.beta[1]! * x + value.beta[2]! * medChains + value.beta[3]! * medG7 });
  }
  const scatter = {
    points: comps.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) })),
    line,
    band: band.halfWidth,
  };

  // Live tokens: every protocol that already trades, by market cap, with the
  // 94 comparables marked — these are the market's own values.
  const compSlugs = new Set(comps.map((p) => p.slug));
  const live: LiveRow[] = snap.protocols
    .filter((p) => !isPre(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      change_7d: p.change_7d,
      in_fit: compSlugs.has(p.slug),
    }));

  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.verdict as 'FARM' | 'THIN' | 'SKIP']++;

  const preToken = snap.protocols.filter(isPre).length;

  const radar: Radar = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    total_protocols: snap.protocols.length,
    pre_token: preToken,
    live_total: snap.protocols.length - preToken,
    watchlist_size: snap.watchlist.length,
    board_size: rows.length,
    early_size: early,
    off_list_size: offList,
    ledger,
    value: {
      beta: value.beta,
      loo: value.loo,
      loo_flat: value.looFlat,
      wf: value.wf,
      wf_flat: value.wfFlat,
      r2: value.r2,
      n: value.n,
      converged: value.converged,
    },
    odds: {
      beta: odds.beta,
      brier: odds.brier,
      brier_base: odds.brierBase,
      base_rate: odds.baseRate,
      n: odds.n,
      converged: odds.converged,
    },
    buckets,
    finf,
    finf_sensitivity: finfSensitivity,
    term_table: terms,
    calibration: cal,
    conformal: { half_width: band.halfWidth, coverage: band.coverage },
    farm: {
      deposit_frac: FARM.depositFrac,
      drop_share: FARM.dropShare,
      horizon_weeks: FARM.horizonWeeks,
      gas_per_week_usd: FARM.gasPerWeekUsd,
      setup_hours: FARM.setupHours,
      hours_per_week: FARM.hoursPerWeek,
      hourly_rate_usd: FARM.hourlyRateUsd,
      cost_usd: farmCostUsd(),
    },
    verdict_counts: verdictCounts,
    scatter,
    rows,
    live,
    watchlist_slugs: [...snap.watchlist],
    self_test: [],
  };

  // Self-tests: the run fails (exit 1) when any fails.
  const tests: Radar['self_test'] = [];
  const covered = snap.watchlist.filter((s) => rows.some((r) => r.slug === s)).length;
  tests.push({ name: 'watchlist 40/40 covered', pass: covered === snap.watchlist.length, detail: `${covered}/${snap.watchlist.length}` });
  tests.push({ name: 'ranks exactly 1..N', pass: rows.every((r, i) => r.rank === i + 1), detail: `${rows.length} rows` });
  tests.push({
    name: 'implied value non-increasing',
    pass: rows.every((r, i) => i === 0 || rows[i - 1]!.implied_value_usd >= r.implied_value_usd),
    detail: `#1 $${rows[0]!.implied_value_usd.toLocaleString()}`,
  });
  tests.push({
    name: 'farm steps 3-12 x 20-600 chars',
    pass: rows.every(
      (r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 &&
        r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600),
    ),
    detail: 'all rows',
  });
  tests.push({
    name: 'every farm step states cost and time',
    pass: rows.every((r) => r.farm_steps.every((s) => s.includes('Cost:') && s.includes('Time:'))),
    detail: 'all rows',
  });
  tests.push({ name: 'implied values positive', pass: rows.every((r) => r.implied_value_usd > 0), detail: 'all rows' });
  tests.push({ name: 'value fit converged', pass: value.converged, detail: `LOO x${value.loo.toFixed(2)}` });
  tests.push({ name: 'odds fit converged', pass: odds.converged, detail: `Brier ${odds.brier.toFixed(3)}` });
  tests.push({ name: 'LOO beats flat', pass: value.loo < value.looFlat, detail: `x${value.loo.toFixed(2)} vs x${value.looFlat.toFixed(2)}` });
  tests.push({ name: 'Brier beats base rate', pass: odds.brier < odds.brierBase, detail: `${odds.brier.toFixed(3)} vs ${odds.brierBase.toFixed(3)}` });
  const youngOdds = condOdds(0.25, buckets, odds.baseRate, finf.point);
  const oldOdds = condOdds(4.5, buckets, odds.baseRate, finf.point);
  tests.push({
    name: 'odds fall with age (the cure fix)',
    pass: youngOdds > oldOdds,
    detail: `0.25y ${(youngOdds * 100).toFixed(0)}% vs 4.5y ${(oldOdds * 100).toFixed(0)}%`,
  });
  const refit = fitValue(comps);
  const drift = Math.max(...refit.beta.map((b, i) => Math.abs(b - value.beta[i]!)));
  tests.push({ name: 'refit deterministic', pass: drift === 0, detail: `max coefficient drift ${drift}` });
  radar.self_test = tests;
  const failed = tests.filter((t) => !t.pass);
  if (failed.length > 0) {
    throw new Error(`self-test failed: ${failed.map((t) => t.name).join('; ')}`);
  }
  return { board: rows, radar };
}

/** The gate's shape, checked before writing: null when the board is valid. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, need 100-4000`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!slugs.has(r.slug)) return `unknown slug ${r.slug}`;
    if (!r.name) return `empty name for ${r.slug}`;
    if (!Number.isInteger(r.rank) || r.rank < 1) return `bad rank for ${r.slug}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `bad implied value for ${r.slug}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `bad farm steps for ${r.slug}`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `farm step length for ${r.slug}`;
    }
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  if (!ranks.every((r, i) => r === i + 1)) return 'ranks are not exactly 1..N';
  const sorted = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.implied_value_usd > sorted[i - 1]!.implied_value_usd) return 'implied value rises with rank';
  }
  if (new Set(board.map((r) => r.implied_value_usd)).size === 1 && board.length > 1) return 'all implied values equal';
  for (const s of snap.watchlist) if (!board.some((r) => r.slug === s)) return `watchlist slug ${s} missing`;
  return null;
}

/** The dashboard's data file: window.RADAR = {...}. Written to /output/data.js. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
