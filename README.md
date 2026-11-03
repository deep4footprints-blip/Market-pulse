# Market Pulse

An intraday snapshot of the Indian market in one page: Nifty and Sensex with intraday charts, broad and sectoral indices, top stock movers, market breadth and industry pulse. True-black editorial UI.

## How it works

```
GitHub Actions (every 5 min, market hours)
   └─ collector/collect.py  ──►  docs/data/snapshot.json
                                   └─ GitHub Pages serves docs/  ──►  browser polls every 60 s
```

- **Data**: public, free, delayed. NSE India (`allIndices`, `marketStatus`, `equity-stockIndices` for NIFTY 500) and Yahoo Finance chart API (5-minute intraday series, Sensex and BSE indices). No API keys.
- **Why a collector and not direct browser calls**: NSE and Yahoo do not send CORS headers and NSE needs a cookie handshake, so a browser cannot call them directly. The collector runs server-side and publishes one static JSON.
- **Failure behaviour**: if nothing could be fetched the run fails and the previous deployment stays live. Partial failures are listed in the page footer.

## Deploy

1. Push this repo to GitHub.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Actions → *Collect and deploy* → Run workflow. Later runs follow the schedule.

## Run locally

```bash
python collector/collect.py docs/data/snapshot.json   # needs access to NSE / Yahoo
python -m http.server -d docs 8000                    # open http://localhost:8000
```

No network access to NSE/Yahoo? Run against synthetic data to preview the UI:

```bash
bash tests/run_demo.sh
```

## Known limits

- **Freshness**: GitHub scheduled workflows are best-effort and often start 5-15 minutes late. The header shows the snapshot time and flips to "Open · delayed" after 15 minutes. For tighter freshness, put a small proxy in front of the same endpoints (e.g. a Cloudflare Worker) and point `load()` in `docs/app.js` at it.
- **NSE may block cloud IPs.** GitHub runners are sometimes rejected by NSE's edge. The collector retries and falls back to Yahoo for headline indices, but constituents, sectoral and breadth data come from NSE only. Check the footer for failed fetches after the first run.
- **BSE coverage** is limited to Sensex and a few S&P BSE indices via Yahoo; there is no BSE sectoral or constituent data.
- Endpoints are unofficial and can change without notice.

## Disclaimer

Informational only, not investment advice. Data is delayed and may differ from exchange terminals.
