# Market Pulse

An intraday snapshot of the Indian market in one page: Nifty and Sensex with intraday charts, broad and sectoral indices, top stock movers, market breadth and industry pulse. True-black editorial UI.

## How it works

```
                      ┌─ Cloudflare Worker (optional, ~30 s edge cache) ─┐
Browser ──polls 30 s──┤        builds the snapshot on demand             ├─► NSE + Yahoo
   │                  └──────────────────────────────────────────────────┘
   └─ falls back to ─► docs/data/snapshot.json  ◄── GitHub Actions (every 5 min, market hours)
```

- **Data**: public, free, delayed. NSE India (`allIndices`, `marketStatus`, `equity-stockIndices` for NIFTY 500) and Yahoo Finance chart API (5-minute intraday series, Sensex, BSE indices). No API keys.
- **Why a server-side hop at all**: NSE and Yahoo send no CORS headers and NSE needs a cookie handshake, so a browser cannot call them directly.
- **Two producers, one schema.** `collector/collect.py` (Actions) and `worker/src/index.js` (Worker) emit the same JSON; `tests/test_worker.mjs` checks they stay in step.
- **Failure behaviour**: Worker down or blocked → the page silently uses the Actions snapshot and says so in the header. Nothing fetched → the Actions run fails and the last good deployment stays live. Partial failures are listed in the page footer.

## Lag: what to expect

| Mode | Added lag on top of the source's own delay |
|---|---|
| Worker | up to `CACHE_TTL` (30 s) + page poll (30 s) |
| Actions snapshot only | 5-15 min (GitHub's scheduler is best-effort) + ~1 min deploy + 1 min poll |

The source delay itself is not removable: NSE's public endpoints are close to live, but Yahoo has historically labelled NSE/BSE quotes ~15 min delayed (Sensex, BSE indices and the chart series come from Yahoo). The header shows `Charts as of HH:MM IST (N min old)` so you can see the real age.

## Deploy

### 1. Site (GitHub Pages)
1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Actions → *Collect and deploy* → Run workflow. Later runs follow the schedule.

### 2. Worker (recommended, cuts lag)
```bash
cd worker
npx wrangler login
npx wrangler deploy          # prints https://market-pulse-proxy.<you>.workers.dev
```
Then set that URL in `docs/config.js`:
```js
window.MARKET_PULSE = { workerUrl: "https://market-pulse-proxy.<you>.workers.dev" };
```
and push. In `worker/wrangler.toml`, `ALLOW_ORIGIN` must match your Pages origin (default `https://deep4footprints-blip.github.io`).

Prefer CI? Add repo secrets `CLOUDFLARE_API_TOKEN` (Workers edit permission) and `CLOUDFLARE_ACCOUNT_ID`; `.github/workflows/worker.yml` then deploys on changes under `worker/`. Free tier is plenty: one Worker run makes ~15 upstream calls (limit 50), and the edge cache means upstream load is ~2 builds/min regardless of viewers.

## Run locally

```bash
python collector/collect.py docs/data/snapshot.json   # needs access to NSE / Yahoo
python -m http.server -d docs 8000                    # http://localhost:8000
```

Without network access to NSE/Yahoo, preview the UI on **synthetic** data (flagged "DEMO DATA" in the header):

```bash
bash tests/run_demo.sh
```

Tests (need the mock server from `tests/mock_server.py` on :8765 and a snapshot written by the collector):

```bash
node tests/test_worker.mjs
```

## Known limits

- **NSE may block cloud IPs** (GitHub runners and/or Cloudflare). If so, constituents, sectoral and breadth data are empty; the footer lists failed fetches. Check it after the first real run. Headline indices fall back to Yahoo.
- **BSE coverage** is Sensex and a few S&P BSE indices via Yahoo; no BSE sectors or constituents.
- **Not tick-level real time.** For live prices use a broker feed; this is a monitoring view.
- Endpoints are unofficial and can change without notice.

## Disclaimer

Informational only, not investment advice. Data is delayed and may differ from exchange terminals.
