/**
 * Market Pulse proxy — Cloudflare Worker.
 *
 * GET /snapshot  ->  same JSON schema as collector/collect.py, built on demand
 *                    and cached at the edge for CACHE_TTL seconds (default 30).
 * GET /health    ->  { ok: true }
 *
 * Why: browsers cannot call NSE / Yahoo directly (no CORS, NSE needs cookies).
 * Lag with this Worker = upstream source delay + at most CACHE_TTL seconds,
 * instead of the 5-15 min GitHub schedule lag.
 *
 * Env (wrangler.toml [vars]): ALLOW_ORIGIN, CACHE_TTL. NSE_BASE / YAHOO_BASE are
 * for tests only.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IST_OFFSET_MS = 19800 * 1000;

const BROAD_ORDER = ['NIFTY 50', 'NIFTY NEXT 50', 'NIFTY 100', 'NIFTY 200', 'NIFTY 500', 'NIFTY LARGEMIDCAP 250',
  'NIFTY MIDCAP 100', 'NIFTY MIDCAP 150', 'NIFTY MIDSMALLCAP 400', 'NIFTY SMALLCAP 100', 'NIFTY SMALLCAP 250',
  'NIFTY MICROCAP 250', 'NIFTY TOTAL MARKET'];
const SECTORAL = new Set(['NIFTY BANK', 'NIFTY AUTO', 'NIFTY FINANCIAL SERVICES', 'NIFTY FMCG', 'NIFTY IT', 'NIFTY MEDIA',
  'NIFTY METAL', 'NIFTY PHARMA', 'NIFTY PSU BANK', 'NIFTY PRIVATE BANK', 'NIFTY REALTY', 'NIFTY HEALTHCARE INDEX',
  'NIFTY CONSUMER DURABLES', 'NIFTY OIL & GAS', 'NIFTY FINANCIAL SERVICES 25/50']);
const KEY_TO_GROUP = { 'BROAD MARKET INDICES': 'broad', 'SECTORAL INDICES': 'sectoral', 'THEMATIC INDICES': 'thematic' };
const YAHOO_HEADLINE = {
  nifty: ['^NSEI', 'Nifty 50', 'NSE'], sensex: ['^BSESN', 'Sensex', 'BSE'],
  banknifty: ['^NSEBANK', 'Bank Nifty', 'NSE'], vix: ['^INDIAVIX', 'India VIX', 'NSE'],
};
const YAHOO_BSE = [['^BSESN', 'S&P BSE Sensex'], ['BSE-100.BO', 'S&P BSE 100'], ['BSE-200.BO', 'S&P BSE 200'],
  ['BSE-500.BO', 'S&P BSE 500'], ['BSE-MIDCAP.BO', 'S&P BSE MidCap'], ['BSE-SMLCAP.BO', 'S&P BSE SmallCap']];

/* ---------------------------------------------------------------- helpers */
const f = (x, d = null) => {
  if (x === null || x === undefined) return d;
  if (typeof x === 'number') return Number.isFinite(x) ? x : d;
  const n = parseFloat(String(x).replace(/,/g, '').trim());
  return Number.isNaN(n) ? d : n;
};
const r2 = x => Math.round(x * 100) / 100;

async function getText(url, headers, timeoutMs = 8000) {
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { await res.arrayBuffer().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
  return { text: await res.text(), headers: res.headers };
}

/* -------------------------------------------------------------------- NSE */
class NSE {
  constructor(base) { this.base = base; this.cookie = ''; this.ready = null; }
  warm() {
    if (!this.ready) {
      this.ready = (async () => {
        const res = await fetch(this.base + '/', {
          headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
          redirect: 'follow', signal: AbortSignal.timeout(8000),
        });
        await res.arrayBuffer().catch(() => {});
        const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        this.cookie = raw.map(c => c.split(';')[0]).join('; ');
      })();
    }
    return this.ready;
  }
  async get(path) {
    await this.warm();
    const headers = {
      'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
      Referer: this.base + '/market-data/live-equity-market', Cookie: this.cookie,
    };
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try { return JSON.parse((await getText(this.base + path, headers)).text); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  async allIndices() {
    const d = await this.get('/api/allIndices');
    const out = [];
    for (const r of d.data || []) {
      const name = String(r.index || r.indexSymbol || '').trim();
      const last = f(r.last);
      if (!name || last === null) continue;
      const key = String(r.key || '').toUpperCase();
      const group = BROAD_ORDER.includes(name) ? 'broad' : SECTORAL.has(name) ? 'sectoral' : (KEY_TO_GROUP[key] || 'other');
      out.push({
        name, group, exchange: 'NSE', last, change: f(r.variation), pChange: f(r.percentChange),
        open: f(r.open), high: f(r.high), low: f(r.low), prevClose: f(r.previousClose),
        yearHigh: f(r.yearHigh), yearLow: f(r.yearLow), advances: f(r.advances), declines: f(r.declines),
        pe: f(r.pe), pb: f(r.pb), dy: f(r.dy), chg30d: f(r.perChange30d), chg365d: f(r.perChange365d),
      });
    }
    return out;
  }
  async marketStatus() {
    const d = await this.get('/api/marketStatus');
    for (const m of d.marketState || []) {
      if (String(m.market || '').toLowerCase().startsWith('capital')) {
        return { state: m.marketStatus, message: m.marketStatusMessage, tradeDate: m.tradeDate };
      }
    }
    return null;
  }
  async stocks(indexName) {
    const d = await this.get('/api/equity-stockIndices?index=' + encodeURIComponent(indexName));
    const rows = [];
    for (const r of d.data || []) {
      if (!r.symbol || r.symbol === indexName || r.priority === 1) continue;
      const last = f(r.lastPrice);
      if (last === null) continue;
      const meta = r.meta || {};
      const row = {
        symbol: r.symbol, name: meta.companyName || r.symbol, industry: meta.industry || 'Others',
        price: last, change: f(r.change), pChange: f(r.pChange), open: f(r.open), high: f(r.dayHigh), low: f(r.dayLow),
        prevClose: f(r.previousClose), volume: f(r.totalTradedVolume, 0), valueCr: r2(f(r.totalTradedValue, 0) / 1e7),
        yearHigh: f(r.yearHigh), yearLow: f(r.yearLow),
      };
      row.offHigh = row.yearHigh ? r2((row.yearHigh - last) / row.yearHigh * 100) : null;
      row.aboveLow = row.yearLow ? r2((last - row.yearLow) / row.yearLow * 100) : null;
      rows.push(row);
    }
    return rows;
  }
}

/* ------------------------------------------------------------------ Yahoo */
async function yahooChart(base, symbol, interval = '5m', range = '1d') {
  const url = `${base}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const { text } = await getText(url, { 'User-Agent': UA, Accept: 'application/json' });
  const res = (JSON.parse(text).chart?.result || [null])[0];
  if (!res) throw new Error('empty chart result');
  const meta = res.meta || {};
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const series = [];
  ts.forEach((t, i) => { if (closes[i] !== null && closes[i] !== undefined) series.push([Math.trunc(t), r2(closes[i])]); });
  let last = f(meta.regularMarketPrice);
  if (last === null && series.length) last = series[series.length - 1][1];
  const prev = f(meta.chartPreviousClose, f(meta.previousClose));
  const chg = last !== null && prev ? last - prev : null;
  const quote = {
    last, prevClose: prev, change: chg !== null ? r2(chg) : null, pChange: chg !== null && prev ? r2(chg / prev * 100) : null,
    high: f(meta.regularMarketDayHigh), low: f(meta.regularMarketDayLow),
    yearHigh: f(meta.fiftyTwoWeekHigh), yearLow: f(meta.fiftyTwoWeekLow), time: meta.regularMarketTime ?? null,
  };
  if (series.length) {
    const vals = series.map(p => p[1]);
    quote.open = series[0][1];
    quote.high = quote.high || Math.max(...vals);
    quote.low = quote.low || Math.min(...vals);
  }
  return [quote, series];
}

/* --------------------------------------------------------------- analysis */
const pick = (rows, key, n, desc, flt) => rows.filter(r => r[key] !== null && r[key] !== undefined && (!flt || flt(r)))
  .sort((a, b) => desc ? b[key] - a[key] : a[key] - b[key]).slice(0, n);
const KEEP = ['symbol', 'name', 'industry', 'price', 'change', 'pChange', 'volume', 'valueCr', 'yearHigh', 'yearLow', 'offHigh', 'aboveLow'];
const compact = r => Object.fromEntries(KEEP.map(k => [k, r[k] ?? null]));
const buildMovers = s => ({
  gainers: pick(s, 'pChange', 15, true).map(compact),
  losers: pick(s, 'pChange', 15, false).map(compact),
  active: pick(s, 'valueCr', 15, true).map(compact),
  volume: pick(s, 'volume', 15, true).map(compact),
  near52wHigh: pick(s, 'offHigh', 15, false, r => r.offHigh >= 0).map(compact),
  near52wLow: pick(s, 'aboveLow', 15, false, r => r.aboveLow >= 0).map(compact),
});
function buildBreadth(stocks) {
  const ch = stocks.map(r => r.pChange).filter(x => x !== null && x !== undefined);
  if (!ch.length) return null;
  const adv = ch.filter(c => c > 0).length, dec = ch.filter(c => c < 0).length;
  const sorted = [...ch].sort((a, b) => a - b), m = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  return {
    universe: 'NIFTY 500', count: ch.length, advances: adv, declines: dec, unchanged: ch.length - adv - dec,
    up2: ch.filter(c => c >= 2).length, down2: ch.filter(c => c <= -2).length,
    medianChange: r2(median), avgChange: r2(ch.reduce((a, b) => a + b, 0) / ch.length),
    nearHigh: stocks.filter(r => r.offHigh !== null && r.offHigh >= 0 && r.offHigh <= 2).length,
    nearLow: stocks.filter(r => r.aboveLow !== null && r.aboveLow >= 0 && r.aboveLow <= 2).length,
  };
}
function buildIndustries(stocks) {
  const g = new Map();
  for (const r of stocks) {
    if (r.pChange === null || r.pChange === undefined) continue;
    if (!g.has(r.industry)) g.set(r.industry, []);
    g.get(r.industry).push(r.pChange);
  }
  const out = [];
  for (const [industry, xs] of g) {
    if (xs.length < 3) continue;
    out.push({ industry, count: xs.length, avgChange: r2(xs.reduce((a, b) => a + b, 0) / xs.length),
      advances: xs.filter(x => x > 0).length, declines: xs.filter(x => x < 0).length });
  }
  return out.sort((a, b) => b.avgChange - a.avgChange);
}

/* ------------------------------------------------------------------ build */
export async function buildSnapshot(env = {}) {
  const nseBase = (env.NSE_BASE || 'https://www.nseindia.com').replace(/\/$/, '');
  const yBase = (env.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/$/, '');
  const diagnostics = [];
  const track = (source, p, detail) => p.then(
    v => { diagnostics.push({ source, ok: true, detail: detail ? detail(v) : '' }); return v; },
    e => { diagnostics.push({ source, ok: false, detail: String(e.message || e).slice(0, 200) }); return null; });

  const nse = new NSE(nseBase);
  const hKeys = Object.keys(YAHOO_HEADLINE);
  // All upstream calls in parallel: the NSE ones share one cookie handshake.
  const [indices0, status, stocks0, ...rest] = await Promise.all([
    track('NSE allIndices', nse.allIndices(), v => `${v.length} indices`),
    track('NSE marketStatus', nse.marketStatus(), v => v?.state || ''),
    track('NSE NIFTY 500 constituents', nse.stocks('NIFTY 500'), v => `${v.length} stocks`),
    ...hKeys.map(k => track(`Yahoo ${YAHOO_HEADLINE[k][0]}`, yahooChart(yBase, YAHOO_HEADLINE[k][0]), v => `${v[1].length} points`)),
    ...YAHOO_BSE.map(([sym]) => track(`Yahoo ${sym}`, yahooChart(yBase, sym, '1d', '5d'))),
  ]);
  const indices = indices0 || [], stocks = stocks0 || [];
  const headline = {}, series = {};
  hKeys.forEach((k, i) => {
    const res = rest[i];
    if (res) { headline[k] = { label: YAHOO_HEADLINE[k][1], exchange: YAHOO_HEADLINE[k][2], ...res[0] }; series[k] = res[1]; }
  });
  const byName = Object.fromEntries(indices.map(r => [r.name, r]));
  const FIELDS = ['last', 'prevClose', 'change', 'pChange', 'open', 'high', 'low', 'yearHigh', 'yearLow'];
  for (const [key, nseName, label] of [['nifty', 'NIFTY 50', 'Nifty 50'], ['banknifty', 'NIFTY BANK', 'Bank Nifty'], ['vix', 'INDIA VIX', 'India VIX']]) {
    const r = byName[nseName];
    if (!r) continue;
    if (!headline[key]) {
      headline[key] = { label, exchange: 'NSE' };
      series[key] = series[key] || [];
    }
    for (const k of FIELDS) if (r[k] !== null && r[k] !== undefined) headline[key][k] = r[k];  // NSE's own figures are closest to source
  }
  YAHOO_BSE.forEach(([, label], i) => {
    const res = rest[hKeys.length + i];
    if (res && res[0].last !== null) indices.push({ name: label, group: 'bse', exchange: 'BSE', ...res[0], chg30d: null, chg365d: null, pe: null });
  });

  if (!Object.keys(headline).length && !indices.length && !stocks.length) return null;
  const now = Date.now();
  const nSeries = series.nifty || [];
  return {
    generatedAt: new Date(now + IST_OFFSET_MS).toISOString().replace(/\.\d+Z$/, '+05:30'),
    generatedEpoch: Math.floor(now / 1000),
    // Last-trade time from Yahoo (5-min bars are stamped at bar *start*, which would overstate age).
    sourceEpoch: headline.nifty?.time ?? (nSeries.length ? nSeries[nSeries.length - 1][0] : null),
    via: 'worker',
    marketStatus: status,
    headline, series,
    indices: indices.filter(r => ['broad', 'sectoral', 'thematic', 'bse'].includes(r.group) || r.name === 'INDIA VIX'),
    breadth: buildBreadth(stocks),
    industries: buildIndustries(stocks),
    movers: stocks.length ? buildMovers(stocks) : null,
    diagnostics,
    notes: 'Public data, typically delayed. Not investment advice.',
  };
}

/* ---------------------------------------------------------------- handler */
export default {
  async fetch(request, env, ctx) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
    const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname !== '/snapshot' && url.pathname !== '/') return json({ error: 'not found' }, 404);

    const ttl = Math.max(5, Number(env.CACHE_TTL || 30));
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const key = new Request(url.origin + '/snapshot');
    if (cache) {
      const hit = await cache.match(key);
      if (hit) { const h = new Headers(hit.headers); Object.entries(cors).forEach(([k, v]) => h.set(k, v)); h.set('X-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h }); }
    }
    let snap = null;
    try { snap = await buildSnapshot(env); } catch (e) { return json({ error: String(e.message || e) }, 502, { 'Cache-Control': 'no-store' }); }
    if (!snap) return json({ error: 'no upstream data' }, 502, { 'Cache-Control': 'no-store' });
    const res = json(snap, 200, { 'Cache-Control': `public, max-age=${ttl}`, 'X-Cache': 'MISS' });
    if (cache) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};
