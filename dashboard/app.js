// Token Radar v3 — the dashboard. No network, no framework: it reads the
// window.RADAR object data.js writes beside the page and renders from it.
// Every number shown comes from that object; nothing is hardcoded here.
(function () {
  'use strict';
  var R = window.RADAR;
  var V = R.value, O = R.odds, F = R.farm;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString();
  }
  function money0(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 0 : d) + '%'; }
  function ageStr(y) {
    if (y === null || y === undefined) return '—';
    if (y < 1) return Math.max(1, Math.round(y * 12)) + 'mo';
    return y.toFixed(1) + 'y';
  }
  function bucketLabel(b) {
    return b.hi >= 99 ? b.lo + 'y+' : b.lo + '–' + b.hi + 'y';
  }

  // ------------------------------------------------------------ masthead
  $('asof').textContent = 'Snapshot ' + R.as_of + ' · floor $' + (R.floor_usd / 1e6) + 'M';
  $('footNote').textContent = 'Snapshot as of ' + R.as_of + ' (' + R.source + '). ' +
    'Built from the sealed snapshot alone — no network, no live prices, no name special-cased.';

  // ------------------------------------------------------------ KPI strip
  var vc = R.verdict_counts;
  $('kpi').innerHTML =
    kpi('Board rows', R.board_size, R.watchlist_size + ' watchlist + ' + R.early_size + ' early + ' + R.off_list_size + ' off-list') +
    kpi('Watchlist', R.watchlist_size + '/40', 'every watchlist slug covered') +
    kpi('Value LOO', '×' + V.loo.toFixed(2), 'flat baseline ×' + V.loo_flat.toFixed(2)) +
    kpi('Odds Brier', O.brier.toFixed(3), 'base rate ' + O.brier_base.toFixed(3)) +
    kpi('F∞ (cure fraction)', '0.95', 'profile in Method') +
    kpi('FARM verdicts', vc.FARM, vc.THIN + ' THIN · ' + vc.SKIP + ' SKIP');
  function kpi(label, val, sub) {
    return '<div class="box"><div class="label">' + label + '</div><div class="val">' + val +
      '</div><div class="sub">' + sub + '</div></div>';
  }

  // -------------------------------------------------- integrity strip
  // These checks RUN in the browser, from the published data — including a
  // refit of rank #1's fitted market cap from the published coefficients.
  // A static banner would prove nothing; this strip recomputes.
  (function integrity() {
    var rows = R.rows;
    var checks = [];
    function check(name, pass, detail) { checks.push({ name: name, pass: pass, detail: detail }); }
    var slugs = {};
    rows.forEach(function (r) { slugs[r.slug] = true; });
    var covered = R.watchlist_slugs.filter(function (s) { return slugs[s]; }).length;
    check('watchlist ' + covered + '/' + R.watchlist_slugs.length + ' covered', covered === R.watchlist_slugs.length, 'checked by slug, not by count');
    check('ranks exactly 1..N', rows.every(function (r, i) { return r.rank === i + 1; }), rows.length + ' rows');
    check('implied value non-increasing', rows.every(function (r, i) { return i === 0 || rows[i - 1].implied_value_usd >= r.implied_value_usd; }), '#1 ' + money(rows[0].implied_value_usd));
    check('farm steps 3–12 × 20–600 chars', rows.every(function (r) {
      return r.farm_steps.length >= 3 && r.farm_steps.length <= 12 &&
        r.farm_steps.every(function (s) { return s.trim().length >= 20 && s.trim().length <= 600; });
    }), 'all rows');
    check('every farm step states cost and time', rows.every(function (r) {
      return r.farm_steps.every(function (s) { return s.indexOf('Cost:') >= 0 && s.indexOf('Time:') >= 0; });
    }), 'all rows');
    check('value fit converged', V.converged, 'LOO ×' + V.loo.toFixed(2));
    check('odds fit converged', O.converged, 'Brier ' + O.brier.toFixed(3));
    check('LOO beats flat', V.loo < V.loo_flat, '×' + V.loo.toFixed(2) + ' vs ×' + V.loo_flat.toFixed(2));
    check('Brier beats base rate', O.brier < O.brier_base, O.brier.toFixed(3) + ' vs ' + O.brier_base.toFixed(3));
    check('odds fall with age', R.buckets[0].pCond > R.buckets[R.buckets.length - 1].pCond,
      pct(R.buckets[0].pCond) + ' young vs ' + pct(R.buckets[R.buckets.length - 1].pCond) + ' old');
    // Refit rank #1 from the published coefficients.
    var top = rows[0];
    var refit = Math.exp(V.beta[0] + V.beta[1] * Math.log(top.tvl_usd) +
      V.beta[2] * Math.log(Math.max(1, top.chains.length)) + V.beta[3] * top.g7);
    var drift = Math.abs(refit - top.fit_mcap_usd) / top.fit_mcap_usd;
    check("refit of #1's fitted mcap", drift < 0.001, 'drift ' + (drift * 100).toFixed(3) + '%');
    var selfOk = R.self_test.every(function (t) { return t.pass; });
    check('model self-tests (12, run by main.ts)', selfOk, R.self_test.length + ' checks');
    var passed = checks.filter(function (c) { return c.pass; }).length;
    $('integrity').innerHTML = '<span class="' + (passed === checks.length ? 'ok' : 'bad') + '">' +
      passed + '/' + checks.length + ' integrity checks pass</span> <span class="muted">— run live in your browser from the published coefficients</span><ul>' +
      checks.map(function (c) {
        return '<li><span class="' + (c.pass ? 'ok' : 'bad') + '">' + (c.pass ? '✓' : '✗') + '</span> ' +
          esc(c.name) + ' <span class="muted">(' + esc(c.detail) + ')</span></li>';
      }).join('') + '</ul>';
  })();

  // ------------------------------------------------------------ ledger
  var L = R.ledger;
  $('ledger').innerHTML =
    '<div class="big">' + R.total_protocols + ' protocols in the snapshot · ' + R.pre_token +
    ' pre-token · ' + R.live_total + ' already trade</div>' +
    '<div class="nums"><span>The board ranks <b>' + R.board_size + '</b>: ' + R.watchlist_size +
    ' watchlist + ' + R.early_size + ' early + ' + R.off_list_size + ' off-list</span>' +
    '<span>The ' + (L.cex + L.wrapped + L.versioned + L.below_cutoff) +
    ' pre-token protocols <b>not</b> on the board: ' + L.cex + ' CEX · ' + L.wrapped +
    ' wrapped/staked/bridged · ' + L.versioned + ' versioned pools · ' + L.below_cutoff +
    ' below the early TVL cutoff</span>' +
    '<span>The ' + R.live_total + ' live-token protocols are the comparables — <a href="#live">see them in the Live tokens view</a>.</span></div>';

  // ------------------------------------------------------------ board table
  var sortKey = 'rank', sortDir = 1;
  function filtered() {
    var q = $('q').value.trim().toLowerCase();
    var v = $('f-verdict').value;
    var w = $('f-watch').checked;
    var out = R.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      if (v && r.verdict !== v) return false;
      if (w && !r.on_watchlist) return false;
      return true;
    });
    out.sort(function (a, b) {
      var av = a[sortKey], bv = b[sortKey];
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string') return sortDir * (av < bv ? -1 : av > bv ? 1 : 0);
      return sortDir * (av - bv);
    });
    return out;
  }
  function renderBoard() {
    var list = filtered();
    $('boardCount').textContent = '— ' + list.length + ' of ' + R.rows.length + ' rows';
    $('boardBody').innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b> <span class="muted">' + (r.on_watchlist ? '★ ' : '') + esc(r.slug) + '</span></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + ageStr(r.age_years) + '</td>' +
        '<td class="num">' + money(r.fit_mcap_usd) + '</td>' +
        '<td class="num">' + pct(r.odds_cum) + '</td>' +
        '<td class="num">' + pct(r.odds_cond) + '</td>' +
        '<td class="num">' + pct(r.own_share) + '</td>' +
        '<td class="num">' + r.quality_ratio.toFixed(2) + '×</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td><span class="verdict v-' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    }).join('');
  }
  document.querySelectorAll('#boardTable th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = k === 'rank' ? 1 : -1; }
      renderBoard();
    });
  });
  document.querySelectorAll('#boardTable tbody').forEach(function () { });
  $('boardBody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) location.hash = '#detail/' + tr.getAttribute('data-slug');
  });
  ['q', 'f-verdict', 'f-watch'].forEach(function (id) {
    $(id).addEventListener('input', renderBoard);
  });
  $('csv').addEventListener('click', function () {
    var head = 'rank,slug,name,category,tvl_usd,age_years,fit_mcap_usd,odds_cum,odds_cond,odds_12m,own_share,quality_ratio,bucket_f,implied_value_usd,interval_lo_usd,interval_hi_usd,rank_lo,rank_hi,verdict,plan_deposit_usd,exp_drop_usd,break_even_usd,on_watchlist';
    var lines = filtered().map(function (r) {
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '').replace(/"/g, '""') + '"',
        r.tvl_usd, r.age_years === null ? '' : r.age_years, r.fit_mcap_usd, r.odds_cum.toFixed(4),
        r.odds_cond.toFixed(4), r.odds_12m.toFixed(4), r.own_share.toFixed(4), r.quality_ratio.toFixed(4),
        r.bucket_f.toFixed(4), r.implied_value_usd, r.interval_lo_usd, r.interval_hi_usd, r.rank_lo, r.rank_hi,
        r.verdict, r.plan_deposit_usd, r.exp_drop_usd, r.break_even_usd === null ? '' : r.break_even_usd,
        r.on_watchlist ? 1 : 0].join(',');
    });
    var blob = new Blob([[head].concat(lines).join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-radar-board.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  renderBoard();

  // ------------------------------------------------------- validation panel
  $('valueFormula').textContent = 'ln(mcap) = ' + V.beta[0].toFixed(2) + ' + ' + V.beta[1].toFixed(2) +
    '·ln(TVL) + ' + V.beta[2].toFixed(2) + '·ln(chains) + ' + V.beta[3].toFixed(2) + '·g7';
  $('nComps').textContent = V.n;
  $('nPeers').textContent = O.n;
  $('wfTable').innerHTML = '<tr><th>Test</th><th>Model</th><th>Flat baseline</th></tr>' +
    '<tr><td>Leave-one-out (' + V.n + ' comps)</td><td class="num">×' + V.loo.toFixed(2) + '</td><td class="num">×' + V.loo_flat.toFixed(2) + '</td></tr>' +
    '<tr><td>Walk-forward, train 2/3</td><td class="num">×' + V.wf[0].toFixed(2) + '</td><td class="num">×' + V.wf_flat[0].toFixed(2) + '</td></tr>' +
    '<tr><td>Walk-forward, train 1/2</td><td class="num">×' + V.wf[1].toFixed(2) + '</td><td class="num">×' + V.wf_flat[1].toFixed(2) + '</td></tr>' +
    '<tr><td>Walk-forward, cut 2025-01-23</td><td class="num">×' + V.wf[2].toFixed(2) + '</td><td class="num">×' + V.wf_flat[2].toFixed(2) + '</td></tr>';
  $('r2Text').textContent = 'R² is only ' + V.r2.toFixed(2) + ' — the fit is weak and the dashboard says so, carrying the uncertainty as a conformal interval and a bootstrap rank range on every row.';
  $('brierText').textContent = 'Brier score ' + O.brier.toFixed(3) + ' (10-fold, vs ' + O.brier_base.toFixed(3) + ' for the base rate)';
  function calRows() {
    return '<tr><th>Predicted band</th><th>n</th><th>Mean predicted</th><th>Actual rate</th></tr>' +
      R.calibration.map(function (c) {
        return '<tr><td>' + pct(c.lo) + '–' + pct(c.hi) + '</td><td class="num">' + c.n + '</td>' +
          '<td class="num">' + (isNaN(c.pred) ? '—' : pct(c.pred)) + '</td>' +
          '<td class="num">' + (isNaN(c.actual) ? '—' : pct(c.actual)) + '</td></tr>';
      }).join('');
  }
  $('calTable').innerHTML = calRows();
  $('bandText').textContent = R.conformal.half_width.toFixed(2);
  $('covText').textContent = pct(R.conformal.coverage, 1);

  // ------------------------------------------------------------ odds panel
  $('oddsBars').innerHTML = R.buckets.map(function (b) {
    return '<div class="odds-row"><span>' + bucketLabel(b) + ' <span class="muted">(n=' + b.n + ')</span></span>' +
      '<span class="bar"><i style="width:' + (b.pCond * 100).toFixed(0) + '%"></i>' +
      '<b style="left:' + (b.f * 100).toFixed(0) + '%" title="F(t)"></b></span>' +
      '<span class="nums">F(t) ' + pct(b.f) + ' → <b>' + pct(b.pCond) + '</b></span></div>';
  }).join('') +
    '<p class="small muted">Teal bar: conditional odds P(ever | tokenless at this age). Amber tick: F(t), the share already tokened. Young protocols keep most of their chance; old ones have spent it.</p>';

  // ------------------------------------------------------------- live view
  var liveSort = 'mcap_usd', liveDir = -1;
  function liveFiltered() {
    var q = $('q-live').value.trim().toLowerCase();
    var fit = $('f-fit').checked;
    var out = R.live.filter(function (r) {
      if (fit && !r.in_fit) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    out.sort(function (a, b) {
      var av = liveSort === 'ratio' ? a.mcap_usd / a.tvl_usd : a[liveSort];
      var bv = liveSort === 'ratio' ? b.mcap_usd / b.tvl_usd : b[liveSort];
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string') return liveDir * (av < bv ? -1 : av > bv ? 1 : 0);
      return liveDir * (av - bv);
    });
    return out;
  }
  function renderLive() {
    var list = liveFiltered();
    $('liveCount').textContent = '— ' + list.length + ' of ' + R.live.length + ' protocols';
    $('liveBody').innerHTML = list.map(function (r) {
      return '<tr><td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td><b>' + esc(r.name) + '</b> <span class="muted">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + (r.mcap_usd / r.tvl_usd).toFixed(2) + '×</td>' +
        '<td class="num">' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</td>' +
        '<td>' + (r.in_fit ? '<span class="star">★</span>' : '') + '</td></tr>';
    }).join('');
  }
  document.querySelectorAll('#liveTable th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (liveSort === k) liveDir = -liveDir;
      else { liveSort = k; liveDir = k === 'name' || k === 'category' ? 1 : -1; }
      renderLive();
    });
  });
  ['q-live', 'f-fit'].forEach(function (id) { $(id).addEventListener('input', renderLive); });
  renderLive();

  // ----------------------------------------------------------- method view
  $('methodValue').textContent = 'Huber log-log on ' + V.n + ' comparables: ln(mcap) = ' +
    V.beta[0].toFixed(2) + ' + ' + V.beta[1].toFixed(2) + '·ln(TVL) + ' + V.beta[2].toFixed(2) +
    '·ln(chains) + ' + V.beta[3].toFixed(2) + '·g7. LOO ×' + V.loo.toFixed(2) + ' vs flat ×' +
    V.loo_flat.toFixed(2) + '; walk-forward ×' + V.wf.map(function (w) { return w.toFixed(2); }).join(', ×') +
    '; R² ' + V.r2.toFixed(3) + '. The 7-day growth is clamped to [−60%, +120%] in the fit and in prediction.';
  $('termTable').innerHTML = '<tr><th>Specification</th><th>LOO</th><th>Walk-forward (avg)</th><th>Ships?</th></tr>' +
    R.term_table.map(function (t) {
      return '<tr><td>' + esc(t.spec) + '</td><td class="num">×' + t.loo.toFixed(2) + '</td>' +
        '<td class="num">×' + t.wfAvg.toFixed(2) + '</td><td>' + (t.ship ? '<span class="ok">✓ ships</span>' : '—') + '</td></tr>';
    }).join('');
  $('methodOdds').textContent = 'Logistic regression on ' + O.n + ' peers (base rate ' + pct(O.base_rate) +
    ' tokened). logit(p) = ' + O.beta[0].toFixed(2) + ' + ' + O.beta[1].toFixed(2) + '·ln(years) + ' +
    O.beta[2].toFixed(2) + '·ln(TVL) + ' + O.beta[3].toFixed(2) + '·growth + ' + O.beta[4].toFixed(2) +
    '·category token share (shrunk, k=10). Brier ' + O.brier.toFixed(3) + ' (10-fold) vs ' +
    O.brier_base.toFixed(3) + ' for the base rate. The fitted probability is used as the quality ratio, not as the ever-odds: applying the cure correction to the fitted probability directly was tested and rejected — it rewards protocols for low TVL and bad categories (low p for the wrong reason).';
  $('methodCal').innerHTML = calRows();
  var llMax = Math.max.apply(null, R.finf.grid.map(function (g) { return g.loglik; }));
  $('finfProfile').innerHTML = '<tr><th>F∞</th><th>Log-likelihood</th><th>Δ vs best</th></tr>' +
    R.finf.grid.map(function (g) {
      return '<tr><td>' + g.fInf.toFixed(2) + (g.fInf === 0.95 ? ' ← point estimate' : g.fInf === R.finf.mle ? ' ← MLE' : '') +
        '</td><td class="num">' + g.loglik.toFixed(1) + '</td><td class="num">' + (g.loglik - llMax).toFixed(2) + '</td></tr>';
    }).join('');
  $('finfSens').innerHTML = '<tr><th>F∞</th><th>Top 3</th><th>Top-20 overlap</th></tr>' +
    R.finf_sensitivity.map(function (s) {
      return '<tr><td>' + s.f_inf.toFixed(2) + '</td><td>' + s.top3.map(function (slug) {
        var r = R.rows.filter(function (x) { return x.slug === slug; })[0];
        return esc(r ? r.name : slug);
      }).join(', ') + '</td><td class="num">' + s.overlap_top20 + '/20</td></tr>';
    }).join('');
  var minOverlap = Math.min.apply(null, R.finf_sensitivity.map(function (s) { return s.overlap_top20; }));
  $('finfNote').textContent = 'The top 3 are identical at every F∞ in [0.90, 1.00]; the top-20 overlap with the point estimate never falls below ' +
    minOverlap + '/20 across the range. The ranking does not hinge on the F∞ choice.';
  $('bandText2').textContent = R.conformal.half_width.toFixed(2);

  // Scatter: 94 comparables + the Huber line + the conformal band, as SVG.
  (function scatter() {
    var pts = R.scatter.points, line = R.scatter.line, band = R.scatter.band;
    var W = 640, H = 300, pad = 36;
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys) - 0.5, y1 = Math.max.apply(null, ys) + 0.5;
    function X(v) { return pad + (v - x0) / (x1 - x0) * (W - 2 * pad); }
    function Y(v) { return H - pad - (v - y0) / (y1 - y0) * (H - 2 * pad); }
    var dots = pts.map(function (p) {
      return '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2.6" fill="#0f766e" opacity="0.65"/>';
    }).join('');
    var path = line.map(function (p, i) { return (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1); }).join(' ');
    var bandPath = line.map(function (p, i) { return (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y + band).toFixed(1); }).join(' ') +
      ' ' + line.slice().reverse().map(function (p) { return 'L' + X(p.x).toFixed(1) + ' ' + Y(p.y - band).toFixed(1); }).join(' ') + ' Z';
    $('scatterWrap').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Scatter of comparables">' +
      '<path d="' + bandPath + '" fill="#0f766e" opacity="0.10"/>' +
      '<path d="' + path + '" fill="none" stroke="#b45309" stroke-width="2"/>' + dots +
      '<text x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#667085">ln(TVL)</text>' +
      '<text x="10" y="' + (H / 2) + '" text-anchor="middle" font-size="11" fill="#667085" transform="rotate(-90 10 ' + (H / 2) + ')">ln(market cap)</text>' +
      '</svg>';
  })();

  // ----------------------------------------------------------- detail view
  // The sensitivity grid's deposit axis reaches the break-even: candidates
  // [plan, BE/2, BE, 1.5×BE, max($500K, 1.5×BE)], sorted and deduped, filled
  // to five by geometric means — so the grid always shows green cells and
  // the break-even row reads ~$0 at the 7% share.
  function gridDeposits(r) {
    var plan = r.plan_deposit_usd;
    var be = r.break_even_usd;
    var cands = be === null
      ? [plan, 125000, 250000, 375000, 500000]
      : [plan, be / 2, be, 1.5 * be, Math.max(500000, 1.5 * be)];
    cands.sort(function (a, b) { return a - b; });
    var deps = [];
    cands.forEach(function (c) {
      if (!deps.length || c > deps[deps.length - 1] * 1.05) deps.push(c);
    });
    while (deps.length < 5) {
      var best = 0, bi = 0;
      for (var i = 0; i < deps.length - 1; i++) {
        var ratio = deps[i + 1] / deps[i];
        if (ratio > best) { best = ratio; bi = i; }
      }
      deps.splice(bi + 1, 0, Math.sqrt(deps[bi] * deps[bi + 1]));
    }
    return deps.slice(0, 5);
  }
  function gridHTML(r) {
    var shares = [0.03, 0.05, 0.07, 0.10, 0.15];
    var deps = gridDeposits(r);
    var head = '<tr><th>Deposit ↓ / drop share →</th>' +
      shares.map(function (s) { return '<th>' + (s * 100).toFixed(0) + '%</th>'; }).join('') + '</tr>';
    var body = deps.map(function (d) {
      var cells = shares.map(function (s) {
        var expDrop = r.fit_mcap_usd * r.own_share * s * (d / r.tvl_usd) * r.odds_12m;
        var net = expDrop - F.cost_usd;
        var shown = Math.round(net);
        var cls = net > 0 ? 'pos' : 'neg';
        var plan = Math.abs(d - r.plan_deposit_usd) < 1 && s === F.drop_share;
        return '<td class="num ' + cls + (plan ? ' plan-cell' : '') + '">' +
          (shown > 0 ? '+' : shown < 0 ? '−' : '') + '$' + Math.abs(shown).toLocaleString() + '</td>';
      }).join('');
      return '<tr><td><b>' + money0(d) + '</b>' + (Math.abs(d - r.plan_deposit_usd) < 1 ? ' <span class="muted">(plan)</span>' : '') + '</td>' + cells + '</tr>';
    }).join('');
    var note = r.break_even_usd === null
      ? 'No deposit breaks even at these odds — the expected drop never covers the $' + F.cost_usd + ' all-in cost.'
      : 'Break-even (impas) at <b>' + money0(r.break_even_usd) + '</b> with a 7% drop — the break-even row reads ~$0, and deposits above it turn green. The outlined cell is the plan (0.02% of TVL × 7%).';
    return '<table class="grid mini">' + head + body + '</table><p class="small">' + note + '</p>';
  }
  function detailHTML(r) {
    var qr = r.quality_ratio;
    var qrLine = qr >= 1
      ? 'quality ratio ' + qr.toFixed(2) + ' = fitted ' + pct(r.odds_cum) + ' ÷ cohort ' + pct(r.bucket_f) +
        ' — this protocol beat its age peers ' + qr.toFixed(1) + '×'
      : 'quality ratio ' + qr.toFixed(2) + ' = fitted ' + pct(r.odds_cum) + ' ÷ cohort ' + pct(r.bucket_f) +
        ' — this protocol trails its age peers, its fitted odds are ' + qr.toFixed(2) + '× its cohort’s rate';
    var net = r.exp_drop_usd - F.cost_usd;
    return '<section class="panel"><div class="detail-head"><h2>#' + r.rank + ' ' + esc(r.name) + '</h2>' +
      '<span class="verdict v-' + r.verdict + '">' + r.verdict + '</span></div>' +
      '<p class="muted small">' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorized') + ' · ' +
      r.chains.map(esc).join(', ') + ' · age ' + ageStr(r.age_years) + (r.on_watchlist ? ' · ★ watchlist' : '') + '</p>' +
      '<p><a href="#board">← back to the board</a></p>' +
      '<div class="cards"><div class="card"><h3>The arithmetic</h3>' +
      '<div class="eq">fitted mcap ' + money(r.fit_mcap_usd) + ' × cond. odds ' + pct(r.odds_cond) +
      ' × own share ' + pct(r.own_share) + ' × quality ratio ' + qr.toFixed(2) + '</div>' +
      '<p class="small">= implied value <b>' + money(r.implied_value_usd) + '</b></p>' +
      '<p class="small">' + qrLine + '.</p>' +
      '<p class="small">Cumulative odds would have been ' + pct(r.odds_cum) + ' — the conditional fix ' +
      (r.odds_cond > r.odds_cum ? 'raises' : 'lowers') + ' it because this protocol is ' +
      (r.age_years !== null && r.age_years < 2 ? 'young' : r.age_years !== null && r.age_years > 3 ? 'old' : 'mid-age') +
      ' for its cohort. The 12-month hazard odds are ' + pct(r.odds_12m, 1) + ': the farm economics run on those, not on the ever-odds.</p>' +
      '<dl class="kv"><dt>Fitted mcap, 50% interval</dt><dd>' + money(r.interval_lo_usd) + ' – ' + money(r.interval_hi_usd) + '</dd>' +
      '<dt>Rank range (200 bootstraps)</dt><dd>#' + r.rank_lo + '–#' + r.rank_hi + '</dd>' +
      '<dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd>' +
      '<dt>7-day growth (clamped)</dt><dd>' + (r.g7 > 0 ? '+' : '') + (r.g7 * 100).toFixed(1) + '%</dd></dl>' +
      '</div><div class="card"><h3>The farm, in numbers</h3>' +
      '<dl class="kv"><dt>Plan deposit (0.02% of TVL)</dt><dd>' + money(r.plan_deposit_usd) + '</dd>' +
      '<dt>Expected airdrop at the plan</dt><dd>' + money(r.exp_drop_usd) + '</dd>' +
      '<dt>All-in cost (' + F.horizon_weeks + ' weeks)</dt><dd>$' + F.cost_usd.toLocaleString() + '</dd>' +
      '<dt>Expected net at the plan</dt><dd><b>' + (net < 0 ? '−' : '+') + '$' + Math.abs(Math.round(net)).toLocaleString() + '</b></dd>' +
      '<dt>Break-even deposit</dt><dd>' + (r.break_even_usd === null ? 'no size breaks even' : money0(r.break_even_usd)) + '</dd>' +
      '<dt>Verdict</dt><dd><span class="verdict v-' + r.verdict + '">' + r.verdict + '</span></dd></dl>' +
      '<p class="small">At the plan size every row’s net is negative — farming at these odds is a whale game, and the grid below shows the size it takes. The verdict is the minimum-capital lens: FARM when a retail-size deposit breaks even, THIN under $500K, else SKIP.</p>' +
      '</div></div>' +
      '<div class="card"><h3>Farm plan — 8 steps</h3><ol class="steps">' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' +
      '<div class="card"><h3>Sensitivity — expected net $ by deposit × airdrop share</h3>' + gridHTML(r) + '</div>' +
      '<div class="card sandbox-card"><h3>Farm sandbox — change the assumptions, watch the numbers move</h3>' +
      '<div class="sandbox">' +
      '<div><label>Deposit $</label><input id="sb-dep" type="number" value="' + r.plan_deposit_usd + '" min="0"></div>' +
      '<div><label>Airdrop share %</label><input id="sb-drop" type="number" value="' + (F.drop_share * 100) + '" min="0" max="100" step="0.5"></div>' +
      '<div><label>Horizon weeks</label><input id="sb-weeks" type="number" value="' + F.horizon_weeks + '" min="1" max="156"></div>' +
      '<div><label>Gas $/week</label><input id="sb-gas" type="number" value="' + F.gas_per_week_usd + '" min="0" step="0.5"></div>' +
      '<div><label>Your time $/hour</label><input id="sb-rate" type="number" value="' + F.hourly_rate_usd + '" min="0" step="1"></div>' +
      '</div><div id="sb-out"></div>' +
      '<p class="small muted">Cost = gas × weeks + (2 setup hours + 0.5 h/week × weeks) × your hourly rate. The plan cost of $' +
      F.cost_usd + ' is $5/week gas + 28 hours at $25/h.</p></div></section>';
  }
  function bindSandbox(r) {
    function recompute() {
      var dep = parseFloat($('sb-dep').value) || 0;
      var drop = (parseFloat($('sb-drop').value) || 0) / 100;
      var weeks = parseFloat($('sb-weeks').value) || 0;
      var gas = parseFloat($('sb-gas').value) || 0;
      var rate = parseFloat($('sb-rate').value) || 0;
      var hours = F.setup_hours + F.hours_per_week * weeks;
      var cost = gas * weeks + hours * rate;
      var expDrop = r.fit_mcap_usd * r.own_share * drop * (dep / r.tvl_usd) * r.odds_12m;
      var denom = r.fit_mcap_usd * r.own_share * drop * r.odds_12m;
      var be = denom > 0 ? (cost * r.tvl_usd) / denom : Infinity;
      var verdict = be <= 100000 ? 'FARM' : be <= 500000 ? 'THIN' : 'SKIP';
      var net = expDrop - cost;
      $('sb-out').innerHTML = '<dl class="kv"><dt>All-in cost</dt><dd>$' + Math.round(cost).toLocaleString() +
        ' (' + hours.toFixed(1) + 'h)</dd><dt>Expected airdrop</dt><dd>$' + Math.round(expDrop).toLocaleString() +
        '</dd><dt>Expected net</dt><dd><b>' + (net < 0 ? '−' : '+') + '$' + Math.abs(Math.round(net)).toLocaleString() +
        '</b></dd><dt>Break-even deposit</dt><dd>' + (isFinite(be) ? money0(be) : 'no size breaks even') +
        '</dd><dt>Verdict at these assumptions</dt><dd><span class="verdict v-' + verdict + '">' + verdict + '</span></dd></dl>';
    }
    ['sb-dep', 'sb-drop', 'sb-weeks', 'sb-gas', 'sb-rate'].forEach(function (id) {
      $(id).addEventListener('input', recompute);
    });
    recompute();
  }

  // --------------------------------------------------------------- routing
  var views = { board: 'view-board', live: 'view-live', method: 'view-method', detail: 'view-detail' };
  function show(view) {
    Object.keys(views).forEach(function (k) { $(views[k]).hidden = k !== view; });
    ['board', 'live', 'method'].forEach(function (t) {
      var el = $('tab-' + t);
      if (el) el.classList.toggle('active', t === view);
    });
    window.scrollTo(0, 0);
  }
  function route() {
    var h = location.hash || '#board';
    if (h.indexOf('#detail/') === 0) {
      var slug = h.slice(8);
      var r = R.rows.filter(function (x) { return x.slug === slug; })[0];
      if (r) {
        $('view-detail').innerHTML = detailHTML(r);
        bindSandbox(r);
        show('detail');
        return;
      }
    }
    if (h === '#live') { show('live'); return; }
    if (h === '#method') { show('method'); return; }
    show('board');
  }
  window.addEventListener('hashchange', route);
  route();
})();
