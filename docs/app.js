/* Market Pulse front-end. Renders data/snapshot.json written by collector/collect.py */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const IN = 'en-IN';
  const WORKER = String((window.MARKET_PULSE || {}).workerUrl || '').replace(/\/$/, '');
  const REFRESH_MS = WORKER ? 30_000 : 60_000;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = n => n !== null && n !== undefined && !Number.isNaN(Number(n));
  const nf = (n, d = 2) => ok(n) ? Number(n).toLocaleString(IN, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const sg = (n, d = 2, suf = '') => !ok(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString(IN, { minimumFractionDigits: d, maximumFractionDigits: d }) + suf;
  const cls = n => !ok(n) ? 'flat' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const tIST = (ep, o = {}) => new Date(ep * 1000).toLocaleTimeString(IN, { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, ...o });
  const dIST = ep => new Date(ep * 1000).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  const pretty = n => String(n).toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bIt\b/, 'IT').replace(/\bFmcg\b/, 'FMCG').replace(/\bPsu\b/, 'PSU').replace(/\bBse\b/, 'BSE')
    .replace(/\bVix\b/, 'VIX').replace(/\bS&p\b/, 'S&P').replace(/\bMidcap\b/, 'MidCap').replace(/\bSmallcap\b/, 'SmallCap')
    .replace(/\bLargemidcap\b/, 'LargeMidCap').replace(/\bMidsmallcap\b/, 'MidSmallCap').replace(/\bMicrocap\b/, 'MicroCap');
  const vol = v => !ok(v) ? '—' : v >= 1e7 ? nf(v / 1e7, 2) + ' Cr' : v >= 1e5 ? nf(v / 1e5, 2) + ' L' : nf(v, 0);
  const rangeBar = (v, lo, hi) => (ok(v) && ok(lo) && ok(hi) && hi > lo)
    ? `<span class="mini"><i style="left:calc(${(clamp((v - lo) / (hi - lo), 0, 1) * 100).toFixed(1)}% - 1px)"></i></span>` : '';

  const BROAD_ORDER = ['NIFTY 50', 'NIFTY NEXT 50', 'NIFTY 100', 'NIFTY 200', 'NIFTY 500', 'NIFTY LARGEMIDCAP 250',
    'NIFTY MIDCAP 100', 'NIFTY MIDCAP 150', 'NIFTY MIDSMALLCAP 400', 'NIFTY SMALLCAP 100', 'NIFTY SMALLCAP 250',
    'NIFTY MICROCAP 250', 'NIFTY TOTAL MARKET'];
  const HEAD_KEYS = ['nifty', 'sensex', 'banknifty', 'vix'];
  const MOVER_TABS = [
    ['gainers', 'Gainers'], ['losers', 'Losers'], ['active', 'Most active (value)'],
    ['volume', 'Volume leaders'], ['near52wHigh', 'Near 52W high'], ['near52wLow', 'Near 52W low'],
  ];

  let snap = null, chartKey = 'nifty', moverKey = 'gainers', lastErr = null;

  /* ---------- data ---------- */
  async function fetchJson(url, ms) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  let loading = false;
  async function load(manual) {
    if (loading) return;
    loading = true;
    const btn = $('#refresh');
    if (manual) btn.textContent = 'Refreshing…';
    let next = null, err = null;
    if (WORKER) {  // live proxy first; fall back to the scheduled snapshot if it is down
      try { next = await fetchJson(WORKER + '/snapshot', 15000); } catch (e) { err = e; }
    }
    if (!next) {
      try {
        next = await fetchJson('data/snapshot.json?t=' + Date.now(), 10000);
        if (WORKER) next.fallback = true;
      } catch (e) { err = err || e; }
    }
    if (next) { snap = next; lastErr = null; } else { lastErr = err; }  // keep the last good data on failure
    btn.textContent = 'Refresh';
    loading = false;
    render();
  }

  /* ---------- helpers over snapshot ---------- */
  const idx = () => snap?.indices || [];
  const byGroup = g => idx().filter(r => r.group === g);
  const named = n => idx().find(r => r.name === n);
  const ageMin = () => snap ? Math.max(0, (Date.now() / 1000 - snap.generatedEpoch) / 60) : null;
  function marketOpenByClock() {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const g = t => p.find(x => x.type === t)?.value;
    const mins = (+g('hour')) * 60 + (+g('minute'));
    return !['Sat', 'Sun'].includes(g('weekday')) && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  }

  /* ---------- status ---------- */
  function renderStatus() {
    const el = $('#status'), as = $('#asof');
    if (!snap) {
      el.className = 'badge'; el.lastElementChild.textContent = lastErr ? 'No data' : 'Loading';
      as.textContent = lastErr ? 'Snapshot unavailable — the collector has not published yet.' : '';
      return;
    }
    const st = (snap.marketStatus?.state || (marketOpenByClock() ? 'Open' : 'Closed'));
    const open = /open/i.test(st);
    const age = ageMin();
    const stale = open && age > 15;
    el.className = 'badge ' + (stale ? 'stale' : open ? 'open' : 'closed');
    el.lastElementChild.textContent = stale ? 'Open · delayed' : (open ? 'Market open' : 'Market closed');
    const ep = snap.generatedEpoch, src = snap.sourceEpoch;
    const ago = age < 1 ? 'just now' : age < 90 ? Math.round(age) + ' min ago' : Math.round(age / 60) + ' h ago';
    const via = snap.via === 'worker' ? 'live proxy' : snap.fallback ? 'scheduled snapshot (proxy unreachable)' : 'scheduled snapshot';
    let txt;
    if (src && open) {  // how old the freshest price in the data actually is, vs. when we fetched it
      const lag = Math.max(0, Math.round((Date.now() / 1000 - src) / 60));
      txt = `Charts as of ${tIST(src)} IST (${lag < 1 ? 'live' : lag + ' min old'}) · fetched ${tIST(ep)} · ${via}`;
    } else if (src) {
      txt = `Last prices ${tIST(src)} IST, ${dIST(src)} · fetched ${ago} · ${via}`;
    } else {
      txt = `Snapshot ${tIST(ep)} IST · ${dIST(ep)} · updated ${ago} · ${via}`;
    }
    as.textContent = txt + (snap.demo ? ' · DEMO DATA' : '');
  }

  /* ---------- scales ---------- */
  function sessionBounds(series) {
    const t0 = series.length ? series[0][0] : Math.floor(Date.now() / 1000);
    const istMid = t0 - ((t0 + 19800) % 86400);
    return [istMid + 9 * 3600 + 15 * 60, istMid + 15 * 3600 + 30 * 60];
  }
  function scaler(series, prev, W, H, pad) {
    const [s, e] = sessionBounds(series);
    const vals = series.map(p => p[1]).concat(ok(prev) ? [prev] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const m = (hi - lo) * 0.08; lo -= m; hi += m;
    const x = t => pad.l + ((clamp(t, s, e) - s) / (e - s)) * (W - pad.l - pad.r);
    const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    return { x, y, lo, hi, s, e };
  }
  const path = (series, sc) => series.map((p, i) => (i ? 'L' : 'M') + sc.x(p[0]).toFixed(1) + ' ' + sc.y(p[1]).toFixed(1)).join('');

  /* ---------- headline strip ---------- */
  function spark(series, prev, up) {
    if (!series || series.length < 2) return '<svg viewBox="0 0 200 40"></svg>';
    const W = 200, H = 40, sc = scaler(series, prev, W, H, { l: 0, r: 0, t: 3, b: 3 });
    const col = up ? 'var(--pos)' : 'var(--neg)';
    const base = ok(prev) ? `<line x1="0" x2="${W}" y1="${sc.y(prev).toFixed(1)}" y2="${sc.y(prev).toFixed(1)}" stroke="#2a2a2a" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${base}<path d="${path(series, sc)}" fill="none" stroke="${col}" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  }
  function renderHeads() {
    const box = $('#heads');
    if (!snap) { box.innerHTML = Array(4).fill('<div class="head"><div class="skel" style="height:96px"></div></div>').join(''); return; }
    const keys = HEAD_KEYS.filter(k => snap.headline?.[k]);
    box.innerHTML = keys.map(k => {
      const h = snap.headline[k], up = (h.pChange ?? 0) >= 0, isVix = k === 'vix';
      return `<div class="head ${k === chartKey ? 'on' : ''}" data-k="${k}" tabindex="0" role="button" aria-label="Show ${esc(h.label)} chart">
        <div class="lab"><span>${esc(h.label)}</span><span>${esc(h.exchange)}</span></div>
        <div class="px">${nf(h.last)}</div>
        <div class="chg ${cls(h.pChange)}">${sg(h.change)} &nbsp; ${sg(h.pChange, 2, '%')}</div>
        ${spark(snap.series?.[k], h.prevClose, up)}
        <div class="rng">${ok(h.low) && ok(h.high) && h.high > h.low ? `<i style="left:calc(${(clamp((h.last - h.low) / (h.high - h.low), 0, 1) * 100).toFixed(1)}% - 1px)"></i>` : ''}</div>
        <div class="rng-l"><span>${nf(h.low)}</span><span>Day range</span><span>${nf(h.high)}</span></div>
      </div>`;
    }).join('');
    box.querySelectorAll('.head').forEach(el => {
      const go = () => { chartKey = el.dataset.k; renderHeads(); renderChartTabs(); renderChart(); };
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  /* ---------- big intraday chart ---------- */
  function renderChartTabs() {
    const box = $('#chart-tabs');
    if (!snap) { box.innerHTML = ''; return; }
    box.innerHTML = HEAD_KEYS.filter(k => snap.headline?.[k])
      .map(k => `<button type="button" role="tab" data-k="${k}" class="${k === chartKey ? 'on' : ''}">${esc(snap.headline[k].label)}</button>`).join('');
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { chartKey = b.dataset.k; renderHeads(); renderChartTabs(); renderChart(); }));
  }
  function renderChart() {
    const host = $('#chart'), meta = $('#chart-meta');
    if (!snap) { host.innerHTML = '<div class="skel" style="height:100%"></div>'; return; }
    const series = snap.series?.[chartKey] || [], h = snap.headline?.[chartKey];
    if (series.length < 2 || !h) {
      host.innerHTML = '<div class="empty">Intraday series unavailable for this instrument right now.</div>'; meta.textContent = ''; return;
    }
    const W = host.clientWidth || 800, H = host.clientHeight || 260, pad = { l: 0, r: 58, t: 10, b: 22 };
    const sc = scaler(series, h.prevClose, W, H, pad);
    const up = series[series.length - 1][1] >= (h.prevClose ?? series[0][1]);
    const col = up ? 'var(--pos)' : 'var(--neg)';
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = sc.lo + (sc.hi - sc.lo) * (i / 4), yy = sc.y(v);
      g += `<line x1="0" x2="${W - pad.r}" y1="${yy}" y2="${yy}" stroke="#141414"/><text x="${W - pad.r + 8}" y="${yy + 3.5}" fill="#666" font-size="10.5">${nf(v, v > 1000 ? 0 : 2)}</text>`;
    }
    let xs = '';
    for (let hh = 10; hh <= 15; hh++) {
      const t = sc.s + (hh * 3600 - (9 * 3600 + 15 * 60)), xx = sc.x(t);
      xs += `<text x="${xx}" y="${H - 6}" fill="#666" font-size="10.5" text-anchor="middle">${hh}:00</text>`;
    }
    const prevLine = ok(h.prevClose) ? `<line x1="0" x2="${W - pad.r}" y1="${sc.y(h.prevClose)}" y2="${sc.y(h.prevClose)}" stroke="#3a3a3a" stroke-dasharray="3 4"/>
      <text x="${W - pad.r + 8}" y="${sc.y(h.prevClose) - 5}" fill="#999" font-size="10">Prev</text>` : '';
    const d = path(series, sc), last = series[series.length - 1];
    const area = `${d}L${sc.x(last[0]).toFixed(1)} ${H - pad.b}L${sc.x(series[0][0]).toFixed(1)} ${H - pad.b}Z`;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">
      <defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${up ? '#36b37e' : '#e05a5a'}" stop-opacity=".14"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
      ${g}${prevLine}${xs}
      <path d="${area}" fill="url(#ga)"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${sc.x(last[0])}" cy="${sc.y(last[1])}" r="3" fill="${col}"/>
      <line id="xh" y1="${pad.t}" y2="${H - pad.b}" stroke="#555" style="display:none"/><circle id="xc" r="3.5" fill="#000" stroke="#f2f2f2" style="display:none"/>
      <rect id="hit" x="0" y="0" width="${W - pad.r}" height="${H}" fill="transparent"/></svg><div class="tip" id="tip"></div>`;
    meta.textContent = `${tIST(series[0][0])}–${tIST(last[0])} IST · 5-min bars`;
    const hit = $('#hit', host), xh = $('#xh', host), xc = $('#xc', host), tip = $('#tip', host);
    const move = ev => {
      const r = host.getBoundingClientRect(), cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      let best = 0, bd = Infinity;
      series.forEach((p, i) => { const dd = Math.abs(sc.x(p[0]) - cx); if (dd < bd) { bd = dd; best = i; } });
      const p = series[best], px = sc.x(p[0]), py = sc.y(p[1]);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xc.setAttribute('cx', px); xc.setAttribute('cy', py);
      xh.style.display = xc.style.display = 'block';
      const chg = ok(h.prevClose) ? ((p[1] / h.prevClose - 1) * 100) : null;
      tip.innerHTML = `${tIST(p[0])} &nbsp; <b style="font-weight:500">${nf(p[1])}</b> &nbsp; <span class="${cls(chg)}">${sg(chg, 2, '%')}</span>`;
      tip.style.cssText = `display:block;left:${clamp(px, 70, W - pad.r - 70)}px;top:${py}px`;
    };
    const leave = () => { xh.style.display = xc.style.display = tip.style.display = 'none'; };
    hit.addEventListener('mousemove', move); hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('mouseleave', leave); hit.addEventListener('touchend', leave);
  }

  /* ---------- commentary ---------- */
  function renderRead() {
    const el = $('#read');
    if (!snap) { el.textContent = ''; return; }
    const H = snap.headline || {}, out = [];
    const dir = p => !ok(p) ? 'flat' : p > 0.05 ? 'up' : p < -0.05 ? 'down' : 'flat';
    const posIn = h => (ok(h?.last) && ok(h?.low) && ok(h?.high) && h.high > h.low) ? (h.last - h.low) / (h.high - h.low) : null;
    const n = H.nifty, s = H.sensex;
    if (n) {
      const p = posIn(n), where = p === null ? '' : p > 0.67 ? ', holding in the upper third of its day range' : p < 0.33 ? ', sitting in the lower third of its day range' : ', trading mid-range';
      out.push(`<b>Nifty</b> is ${dir(n.pChange)} ${nf(Math.abs(n.pChange))}% at ${nf(n.last, 0)}` +
        (s ? ` and <b>Sensex</b> ${dir(s.pChange)} ${nf(Math.abs(s.pChange))}%` : '') + where + '.');
    } else if (s) out.push(`<b>Sensex</b> is ${dir(s.pChange)} ${nf(Math.abs(s.pChange))}% at ${nf(s.last, 0)}.`);
    const b = snap.breadth;
    if (b) {
      const r = b.advances / Math.max(1, b.declines);
      const q = r > 1.5 ? 'strongly positive' : r > 1.1 ? 'positive' : r < 0.67 ? 'weak' : r < 0.9 ? 'negative' : 'mixed';
      out.push(`Breadth is ${q}: ${b.advances} advancers to ${b.declines} decliners across the NIFTY 500, median stock ${sg(b.medianChange, 2, '%')}.`);
    }
    const sec = byGroup('sectoral').filter(r => ok(r.pChange)).sort((a, c) => c.pChange - a.pChange);
    if (sec.length >= 3) {
      const t = sec.slice(0, 2), w = sec[sec.length - 1];
      out.push(`${pretty(t[0].name)} (${sg(t[0].pChange, 2, '%')}) and ${pretty(t[1].name)} lead; ${pretty(w.name)} (${sg(w.pChange, 2, '%')}) lags.`);
    }
    const sm = named('NIFTY SMALLCAP 250'), l = named('NIFTY 50');
    if (sm && l && ok(sm.pChange) && ok(l.pChange)) {
      const d = sm.pChange - l.pChange;
      out.push(Math.abs(d) < 0.3 ? 'Large and small caps are moving in step.' : d > 0 ? `Small caps are outperforming large caps by ${nf(d)} points.` : `Small caps are lagging large caps by ${nf(-d)} points.`);
    }
    if (H.vix) out.push(`India VIX is ${nf(H.vix.last)} (${sg(H.vix.pChange, 2, '%')}).`);
    el.innerHTML = out.join(' ');
  }

  /* ---------- tables ---------- */
  const th = (...c) => '<thead><tr>' + c.map(x => `<th>${x}</th>`).join('') + '</tr></thead>';
  function empty(id, msg) { $(id).innerHTML = `<tbody><tr><td class="empty" colspan="9">${esc(msg)}</td></tr></tbody>`; }

  function renderBroad() {
    if (!snap) return empty('#t-broad', 'Loading…');
    const nse = byGroup('broad').sort((a, b) => BROAD_ORDER.indexOf(a.name) - BROAD_ORDER.indexOf(b.name));
    const rows = nse.concat(byGroup('bse'));
    if (!rows.length) return empty('#t-broad', 'Index data unavailable in the latest snapshot.');
    $('#t-broad').innerHTML = th('Index', 'Last', 'Chg', '% Chg', 'Day range', '52W range', '30D', '1Y', 'P/E') + '<tbody>' + rows.map(r => `
      <tr><td class="nm">${esc(pretty(r.name))}<span class="sub">${esc(r.exchange)}</span></td>
      <td>${nf(r.last)}</td><td class="${cls(r.change)}">${sg(r.change)}</td><td class="${cls(r.pChange)}">${sg(r.pChange, 2, '%')}</td>
      <td class="dim">${rangeBar(r.last, r.low, r.high)}</td><td class="dim">${rangeBar(r.last, r.yearLow, r.yearHigh)}</td>
      <td class="${cls(r.chg30d)}">${sg(r.chg30d, 1, '%')}</td><td class="${cls(r.chg365d)}">${sg(r.chg365d, 1, '%')}</td>
      <td class="dim">${nf(r.pe, 1)}</td></tr>`).join('') + '</tbody>';
  }

  function bars(box, items) {
    const max = Math.max(0.5, ...items.map(i => Math.abs(i.v)));
    box.innerHTML = items.map(i => {
      const w = Math.abs(i.v) / max * 50, pos = i.v >= 0;
      return `<div class="bar" title="${esc(i.t || i.n)}"><span class="n">${esc(i.n)}</span><span class="tr"><span class="f" style="${pos ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${pos ? 'var(--pos)' : 'var(--neg)'}"></span></span><span class="v ${cls(i.v)}">${sg(i.v, 2, '%')}</span></div>`;
    }).join('');
  }

  function renderSectors() {
    if (!snap) { empty('#t-sector', 'Loading…'); empty('#t-thematic', ''); return; }
    const sec = byGroup('sectoral').filter(r => ok(r.pChange)).sort((a, b) => b.pChange - a.pChange);
    if (!sec.length) { $('#sector-bars').innerHTML = ''; empty('#t-sector', 'Sectoral data unavailable in the latest snapshot.'); empty('#t-thematic', ''); return; }
    const up = sec.filter(r => r.pChange > 0).length;
    $('#sec-meta').textContent = `${up} up · ${sec.length - up} down`;
    bars($('#sector-bars'), sec.map(r => ({ n: pretty(r.name).replace(/^Nifty /, ''), v: r.pChange, t: pretty(r.name) })));
    const row = r => `<tr><td class="nm">${esc(pretty(r.name))}</td><td>${nf(r.last)}</td><td class="${cls(r.pChange)}">${sg(r.pChange, 2, '%')}</td>
      <td class="dim">${rangeBar(r.last, r.low, r.high)}</td><td class="${cls(r.chg30d)}">${sg(r.chg30d, 1, '%')}</td><td class="${cls(r.chg365d)}">${sg(r.chg365d, 1, '%')}</td>
      <td class="dim">${nf(r.pe, 1)}</td><td class="dim">${ok(r.advances) ? `<span class="pos">${r.advances}</span> / <span class="neg">${r.declines}</span>` : '—'}</td></tr>`;
    $('#t-sector').innerHTML = th('Index', 'Last', '% Chg', 'Day range', '30D', '1Y', 'P/E', 'Adv / Dec') + '<tbody>' + sec.map(row).join('') + '</tbody>';
    const th2 = byGroup('thematic').filter(r => ok(r.pChange)).sort((a, b) => b.pChange - a.pChange);
    const pick = th2.length > 10 ? th2.slice(0, 5).concat(th2.slice(-5)) : th2;
    $('#t-thematic').innerHTML = pick.length ? th('Index', 'Last', '% Chg', 'Day range', '30D', '1Y', 'P/E', 'Adv / Dec') + '<tbody>' + pick.map(row).join('') + '</tbody>' : '';
  }

  function renderMoverTabs() {
    const box = $('#mover-tabs');
    box.innerHTML = MOVER_TABS.map(([k, l]) => `<button type="button" role="tab" data-k="${k}" class="${k === moverKey ? 'on' : ''}">${l}</button>`).join('');
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { moverKey = b.dataset.k; renderMoverTabs(); renderMovers(); }));
  }
  function renderMovers() {
    if (!snap) return empty('#t-movers', 'Loading…');
    const rows = snap.movers?.[moverKey];
    if (!rows?.length) return empty('#t-movers', 'Stock-level data unavailable in the latest snapshot.');
    $('#t-movers').innerHTML = th('Stock', '<span style="float:left">Industry</span>', 'Last', 'Chg', '% Chg', 'Volume', 'Value ₹ Cr', 'Off 52W high', 'Above 52W low') + '<tbody>' + rows.map(r => `
      <tr><td class="nm">${esc(r.symbol)}<span class="sub">${esc(r.name)}</span></td><td class="dim l">${esc(r.industry)}</td>
      <td>${nf(r.price)}</td><td class="${cls(r.change)}">${sg(r.change)}</td><td class="${cls(r.pChange)}">${sg(r.pChange, 2, '%')}</td>
      <td class="dim">${vol(r.volume)}</td><td class="dim">${nf(r.valueCr, 0)}</td>
      <td class="dim">${ok(r.offHigh) ? nf(r.offHigh, 1) + '%' : '—'}</td><td class="dim">${ok(r.aboveLow) ? nf(r.aboveLow, 1) + '%' : '—'}</td></tr>`).join('') + '</tbody>';
  }

  /* ---------- breadth ---------- */
  function renderBreadth() {
    const box = $('#breadth-body'), ind = $('#industry-bars');
    const b = snap?.breadth;
    if (!b) { box.innerHTML = `<div class="empty">${snap ? 'Breadth data unavailable in the latest snapshot.' : 'Loading…'}</div>`; ind.innerHTML = ''; return; }
    $('#breadth-meta').textContent = `${b.universe} · ${b.count} stocks`;
    const tot = b.advances + b.declines + b.unchanged || 1, pc = x => (x / tot * 100).toFixed(1);
    const secs = byGroup('sectoral').filter(r => ok(r.pChange));
    const st = (k, v, c = '') => `<div class="stat"><div class="k">${k}</div><div class="x ${c}">${v}</div></div>`;
    box.innerHTML = `
      <div class="adv"><i style="width:${pc(b.advances)}%;background:var(--pos)"></i><i style="width:${pc(b.unchanged)}%;background:#444"></i><i style="width:${pc(b.declines)}%;background:var(--neg)"></i></div>
      <div class="adv-l"><span class="pos">${b.advances} advancing (${pc(b.advances)}%)</span><span class="flat">${b.unchanged} unch</span><span class="neg">${b.declines} declining (${pc(b.declines)}%)</span></div>
      <div class="stats">
        ${st('Median stock', sg(b.medianChange, 2, '%'), cls(b.medianChange))}
        ${st('Average stock', sg(b.avgChange, 2, '%'), cls(b.avgChange))}
        ${st('Up 2% or more', b.up2, 'pos')}${st('Down 2% or more', b.down2, 'neg')}
        ${st('Within 2% of 52W high', b.nearHigh)}${st('Within 2% of 52W low', b.nearLow)}
        ${st('Sectors up', secs.filter(r => r.pChange > 0).length, 'pos')}${st('Sectors down', secs.filter(r => r.pChange < 0).length, 'neg')}
      </div>`;
    const inds = snap.industries || [];
    const pick = inds.length > 16 ? inds.slice(0, 8).concat(inds.slice(-8)) : inds;
    bars(ind, pick.map(r => ({ n: `${r.industry} · ${r.count}`, v: r.avgChange, t: `${r.industry}: ${r.advances} up, ${r.declines} down` })));
  }

  /* ---------- footer ---------- */
  function renderDiag() {
    const el = $('#diag');
    if (!snap) { el.textContent = lastErr ? 'Could not load data/snapshot.json (' + lastErr.message + ').' : ''; return; }
    const d = snap.diagnostics || [], bad = d.filter(x => !x.ok);
    el.innerHTML = `Sources: NSE India (indices, constituents, market status) · Yahoo Finance (intraday series, Sensex, BSE indices). ` +
      (bad.length ? `<span style="color:var(--accent)">${bad.length} of ${d.length} fetches failed in the last run: ${bad.map(x => esc(x.source)).join(', ')}.</span>` : 'All fetches succeeded in the last run.');
  }

  /* ---------- orchestration ---------- */
  function render() {
    renderStatus(); renderHeads(); renderChartTabs(); renderChart(); renderRead();
    renderBroad(); renderSectors(); renderMovers(); renderBreadth(); renderDiag();
  }

  function init() {
    renderMoverTabs();
    $('#refresh').addEventListener('click', () => load(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    setInterval(() => load(), REFRESH_MS);
    setInterval(renderStatus, 30_000);
    let rz; new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(renderChart, 120); }).observe($('#chart'));
    const links = [...document.querySelectorAll('.nav a')];
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
    }), { rootMargin: '-30% 0px -60% 0px' });
    document.querySelectorAll('main .sec').forEach(s => io.observe(s));
    render();
    load();
  }
  init();
})();
