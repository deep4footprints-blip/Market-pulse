// Run: node tests/test_worker.mjs   (needs the mock server on :8765 and a Python snapshot at docs/data/snapshot.json)
// Checks the Worker handler and that its output has the same shape as collector/collect.py.
import fs from 'node:fs';
import worker from '../worker/src/index.js';

const env = { NSE_BASE: 'http://127.0.0.1:8765', YAHOO_BASE: 'http://127.0.0.1:8765', ALLOW_ORIGIN: 'https://example.github.io', CACHE_TTL: '30' };
const ctx = { waitUntil() {} };
let failed = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' - ' + extra : '')); if (!cond) failed++; };

const call = (path, method = 'GET') => worker.fetch(new Request('http://worker.test' + path, { method }), env, ctx);

let r = await call('/snapshot', 'OPTIONS');
check('OPTIONS -> 204 with CORS', r.status === 204 && r.headers.get('access-control-allow-origin') === env.ALLOW_ORIGIN);
r = await call('/health');
check('/health ok', r.status === 200 && (await r.json()).ok === true);
r = await call('/nope');
check('unknown path -> 404', r.status === 404);
r = await call('/snapshot', 'POST');
check('POST -> 405', r.status === 405);

r = await call('/snapshot');
const w = await r.json();
check('/snapshot 200 + cache header', r.status === 200 && /max-age=30/.test(r.headers.get('cache-control') || ''));
check('CORS origin pinned', r.headers.get('access-control-allow-origin') === env.ALLOW_ORIGIN);
check('via=worker', w.via === 'worker');

// Shape parity with the Python collector: same key paths (arrays collapsed to their first element).
const paths = (o, p = '', out = new Set()) => {
  if (Array.isArray(o)) { if (o.length) paths(o[0], p + '[]', out); else out.add(p + '[]'); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) paths(o[k], p + '.' + k, out); }
  else out.add(p);
  return out;
};
const py = JSON.parse(fs.readFileSync(new URL('../docs/data/snapshot.json', import.meta.url)));
const pw = paths(w), pp = paths(py);
const skip = k => k === '.demo' || k === '.fallback';
const onlyW = [...pw].filter(k => !pp.has(k) && !skip(k)), onlyP = [...pp].filter(k => !pw.has(k) && !skip(k));
// Per-index optional fields (e.g. BSE rows lack advances) can legitimately differ in which row is first; ignore diagnostics detail.
check('same key paths as collect.py', !onlyW.length && !onlyP.length, `onlyWorker=${JSON.stringify(onlyW.slice(0, 6))} onlyPython=${JSON.stringify(onlyP.slice(0, 6))}`);

check('indices present', w.indices.length >= 20, String(w.indices.length));
check('breadth over 500 stocks', w.breadth?.count === 500, JSON.stringify(w.breadth));
check('six mover lists of 15', Object.values(w.movers).every(a => a.length === 15));
check('losers sorted ascending', w.movers.losers[0].pChange <= w.movers.losers[1].pChange);
check('sensex headline + series', w.headline.sensex?.last > 0 && w.series.sensex.length > 10);
check('sourceEpoch = Nifty last-trade time', w.sourceEpoch === w.headline.nifty.time && w.sourceEpoch > 0);
check('failed Yahoo symbol recorded, not fatal', w.diagnostics.some(d => !d.ok && /BSE-SMLCAP/.test(d.source)) && w.indices.every(i => i.name !== 'S&P BSE SmallCap'));
check('generatedAt is IST', /\+05:30$/.test(w.generatedAt));

// Total upstream failure -> 502, never an empty 200.
const dead = { ...env, NSE_BASE: 'http://127.0.0.1:1', YAHOO_BASE: 'http://127.0.0.1:1' };
r = await worker.fetch(new Request('http://worker.test/snapshot'), dead, ctx);
check('all upstreams down -> 502 no-store', r.status === 502 && r.headers.get('cache-control') === 'no-store');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
