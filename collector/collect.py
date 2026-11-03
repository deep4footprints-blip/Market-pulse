#!/usr/bin/env python3
"""Market Pulse collector.

Pulls public, free, delayed market data and writes one snapshot.json that the
static front-end renders.

Sources (all public, no API keys):
  * NSE India  - allIndices, marketStatus, equity-stockIndices (NIFTY 500)
  * Yahoo Finance chart API - intraday series, Sensex and BSE indices

Exit code is non-zero if nothing usable was fetched, so a scheduled workflow
fails instead of publishing an empty snapshot over the last good one.

Usage: python collect.py [output_path]
Env overrides (used by tests): NSE_BASE, YAHOO_BASE
"""
import datetime as dt
import gzip
import http.cookiejar
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
NSE_BASE = os.environ.get("NSE_BASE", "https://www.nseindia.com").rstrip("/")
YAHOO_BASE = os.environ.get("YAHOO_BASE", "https://query1.finance.yahoo.com").rstrip("/")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

BROAD_ORDER = [
    "NIFTY 50", "NIFTY NEXT 50", "NIFTY 100", "NIFTY 200", "NIFTY 500",
    "NIFTY LARGEMIDCAP 250", "NIFTY MIDCAP 100", "NIFTY MIDCAP 150",
    "NIFTY MIDSMALLCAP 400", "NIFTY SMALLCAP 100", "NIFTY SMALLCAP 250",
    "NIFTY MICROCAP 250", "NIFTY TOTAL MARKET",
]
SECTORAL_NAMES = {
    "NIFTY BANK", "NIFTY AUTO", "NIFTY FINANCIAL SERVICES", "NIFTY FMCG",
    "NIFTY IT", "NIFTY MEDIA", "NIFTY METAL", "NIFTY PHARMA",
    "NIFTY PSU BANK", "NIFTY PRIVATE BANK", "NIFTY REALTY",
    "NIFTY HEALTHCARE INDEX", "NIFTY CONSUMER DURABLES", "NIFTY OIL & GAS",
    "NIFTY FINANCIAL SERVICES 25/50",
}
KEY_TO_GROUP = {
    "BROAD MARKET INDICES": "broad",
    "SECTORAL INDICES": "sectoral",
    "THEMATIC INDICES": "thematic",
}

# Yahoo symbols -> (key, label, exchange)
YAHOO_HEADLINE = {
    "nifty": ("^NSEI", "Nifty 50", "NSE"),
    "sensex": ("^BSESN", "Sensex", "BSE"),
    "banknifty": ("^NSEBANK", "Bank Nifty", "NSE"),
    "vix": ("^INDIAVIX", "India VIX", "NSE"),
}
YAHOO_BSE_INDICES = [
    ("^BSESN", "S&P BSE Sensex"),
    ("BSE-100.BO", "S&P BSE 100"),
    ("BSE-200.BO", "S&P BSE 200"),
    ("BSE-500.BO", "S&P BSE 500"),
    ("BSE-MIDCAP.BO", "S&P BSE MidCap"),
    ("BSE-SMLCAP.BO", "S&P BSE SmallCap"),
]

diagnostics = []


def log(source, ok, detail=""):
    diagnostics.append({"source": source, "ok": bool(ok), "detail": str(detail)[:200]})
    print(("OK   " if ok else "FAIL ") + source + (f" - {detail}" if detail else ""), file=sys.stderr)


def make_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def http_get(opener, url, headers=None, retries=3, timeout=20):
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
    }
    h.update(headers or {})
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            with opener.open(req, timeout=timeout) as r:
                raw = r.read()
                enc = (r.headers.get("Content-Encoding") or "").lower()
                if enc == "gzip":
                    raw = gzip.decompress(raw)
                elif enc == "deflate":
                    raw = zlib.decompress(raw)
                return raw.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - surface any network failure
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def get_json(opener, url, headers=None, retries=3):
    return json.loads(http_get(opener, url, headers, retries))


def f(x, default=None):
    """Tolerant float: NSE sometimes sends '-', '', '1,234.5' or None."""
    if x is None:
        return default
    if isinstance(x, (int, float)):
        return float(x)
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return default


# ---------------------------------------------------------------- NSE

class NSE:
    def __init__(self):
        self.op = make_opener()
        self.hdr = {"Referer": NSE_BASE + "/market-data/live-equity-market"}
        self.ready = False

    def warm(self):
        if self.ready:
            return
        http_get(self.op, NSE_BASE + "/", {"Accept": "text/html,*/*"}, retries=2)
        try:
            http_get(self.op, NSE_BASE + "/market-data/live-equity-market",
                     {"Accept": "text/html,*/*"}, retries=1)
        except Exception:  # noqa: BLE001 - cookie priming is best-effort
            pass
        self.ready = True

    def get(self, path):
        self.warm()
        return get_json(self.op, NSE_BASE + path, self.hdr)

    def all_indices(self):
        d = self.get("/api/allIndices")
        out = []
        for r in d.get("data", []):
            name = (r.get("index") or r.get("indexSymbol") or "").strip()
            last = f(r.get("last"))
            if not name or last is None:
                continue
            key = (r.get("key") or "").upper()
            if name in BROAD_ORDER:
                group = "broad"
            elif name in SECTORAL_NAMES:
                group = "sectoral"
            else:
                group = KEY_TO_GROUP.get(key, "other")
            out.append({
                "name": name, "group": group, "exchange": "NSE", "last": last,
                "change": f(r.get("variation")), "pChange": f(r.get("percentChange")),
                "open": f(r.get("open")), "high": f(r.get("high")), "low": f(r.get("low")),
                "prevClose": f(r.get("previousClose")),
                "yearHigh": f(r.get("yearHigh")), "yearLow": f(r.get("yearLow")),
                "advances": f(r.get("advances")), "declines": f(r.get("declines")),
                "pe": f(r.get("pe")), "pb": f(r.get("pb")), "dy": f(r.get("dy")),
                "chg30d": f(r.get("perChange30d")), "chg365d": f(r.get("perChange365d")),
            })
        return out

    def market_status(self):
        d = self.get("/api/marketStatus")
        for m in d.get("marketState", []):
            if (m.get("market") or "").lower().startswith("capital"):
                return {
                    "state": m.get("marketStatus"),
                    "message": m.get("marketStatusMessage"),
                    "tradeDate": m.get("tradeDate"),
                }
        return None

    def stocks(self, index_name):
        q = urllib.parse.quote(index_name)
        d = self.get(f"/api/equity-stockIndices?index={q}")
        rows = []
        for r in d.get("data", []):
            sym = r.get("symbol")
            if not sym or sym == index_name or r.get("priority") == 1:
                continue
            meta = r.get("meta") or {}
            last = f(r.get("lastPrice"))
            if last is None:
                continue
            tv = f(r.get("totalTradedValue"), 0.0)
            rows.append({
                "symbol": sym,
                "name": meta.get("companyName") or sym,
                "industry": meta.get("industry") or "Others",
                "price": last, "change": f(r.get("change")), "pChange": f(r.get("pChange")),
                "open": f(r.get("open")), "high": f(r.get("dayHigh")), "low": f(r.get("dayLow")),
                "prevClose": f(r.get("previousClose")),
                "volume": f(r.get("totalTradedVolume"), 0.0),
                "valueCr": round(tv / 1e7, 2),
                "yearHigh": f(r.get("yearHigh")), "yearLow": f(r.get("yearLow")),
            })
        for r in rows:
            yh, yl, p = r["yearHigh"], r["yearLow"], r["price"]
            # % below the 52w high (>= 0) and % above the 52w low (>= 0), computed
            # here because NSE's own nearWKH/nearWKL sign conventions vary.
            r["offHigh"] = round((yh - p) / yh * 100, 2) if yh else None
            r["aboveLow"] = round((p - yl) / yl * 100, 2) if yl else None
        return rows


# -------------------------------------------------------------- Yahoo

def yahoo_chart(op, symbol, interval="5m", rng="1d"):
    q = urllib.parse.quote(symbol, safe="")
    d = get_json(op, f"{YAHOO_BASE}/v8/finance/chart/{q}?interval={interval}&range={rng}&includePrePost=false")
    res = (d.get("chart", {}).get("result") or [None])[0]
    if not res:
        raise RuntimeError("empty chart result")
    meta = res.get("meta", {})
    ts = res.get("timestamp") or []
    closes = ((res.get("indicators", {}).get("quote") or [{}])[0]).get("close") or []
    series = [[int(t), round(c, 2)] for t, c in zip(ts, closes) if c is not None]
    last = f(meta.get("regularMarketPrice"))
    if last is None and series:
        last = series[-1][1]
    prev = f(meta.get("chartPreviousClose"), f(meta.get("previousClose")))
    chg = (last - prev) if (last is not None and prev) else None
    pch = (chg / prev * 100) if (chg is not None and prev) else None
    quote = {
        "last": last, "prevClose": prev,
        "change": round(chg, 2) if chg is not None else None,
        "pChange": round(pch, 2) if pch is not None else None,
        "high": f(meta.get("regularMarketDayHigh")), "low": f(meta.get("regularMarketDayLow")),
        "yearHigh": f(meta.get("fiftyTwoWeekHigh")), "yearLow": f(meta.get("fiftyTwoWeekLow")),
        "time": meta.get("regularMarketTime"),
    }
    if series:
        vals = [p[1] for p in series]
        quote["open"] = series[0][1]
        quote["high"] = quote["high"] or max(vals)
        quote["low"] = quote["low"] or min(vals)
    return quote, series


# ------------------------------------------------------------ analysis

def pick(rows, key, n=15, reverse=True, flt=None):
    xs = [r for r in rows if r.get(key) is not None and (flt is None or flt(r))]
    xs.sort(key=lambda r: r[key], reverse=reverse)
    return xs[:n]


def compact(r):
    keep = ("symbol", "name", "industry", "price", "change", "pChange", "volume",
            "valueCr", "yearHigh", "yearLow", "offHigh", "aboveLow")
    return {k: r.get(k) for k in keep}


def build_movers(stocks):
    return {
        "gainers": [compact(r) for r in pick(stocks, "pChange", 15, True)],
        "losers": [compact(r) for r in pick(stocks, "pChange", 15, False)],
        "active": [compact(r) for r in pick(stocks, "valueCr", 15, True)],
        "volume": [compact(r) for r in pick(stocks, "volume", 15, True)],
        "near52wHigh": [compact(r) for r in pick(stocks, "offHigh", 15, False,
                                                  lambda r: r["offHigh"] >= 0)],
        "near52wLow": [compact(r) for r in pick(stocks, "aboveLow", 15, False,
                                                 lambda r: r["aboveLow"] >= 0)],
    }


def build_breadth(stocks):
    ch = [r["pChange"] for r in stocks if r.get("pChange") is not None]
    if not ch:
        return None
    adv = sum(1 for c in ch if c > 0)
    dec = sum(1 for c in ch if c < 0)
    return {
        "universe": "NIFTY 500", "count": len(ch),
        "advances": adv, "declines": dec, "unchanged": len(ch) - adv - dec,
        "up2": sum(1 for c in ch if c >= 2), "down2": sum(1 for c in ch if c <= -2),
        "medianChange": round(statistics.median(ch), 2),
        "avgChange": round(sum(ch) / len(ch), 2),
        "nearHigh": sum(1 for r in stocks if r.get("offHigh") is not None and 0 <= r["offHigh"] <= 2),
        "nearLow": sum(1 for r in stocks if r.get("aboveLow") is not None and 0 <= r["aboveLow"] <= 2),
    }


def build_industries(stocks):
    g = {}
    for r in stocks:
        if r.get("pChange") is None:
            continue
        g.setdefault(r["industry"], []).append(r["pChange"])
    out = []
    for name, xs in g.items():
        if len(xs) < 3:
            continue
        out.append({
            "industry": name, "count": len(xs),
            "avgChange": round(sum(xs) / len(xs), 2),
            "advances": sum(1 for x in xs if x > 0), "declines": sum(1 for x in xs if x < 0),
        })
    out.sort(key=lambda r: r["avgChange"], reverse=True)
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "docs/data/snapshot.json"
    now = dt.datetime.now(IST)
    nse = NSE()
    yop = make_opener()

    indices, stocks, status = [], [], None

    try:
        indices = nse.all_indices()
        log("NSE allIndices", bool(indices), f"{len(indices)} indices")
    except Exception as e:  # noqa: BLE001
        log("NSE allIndices", False, e)
    try:
        status = nse.market_status()
        log("NSE marketStatus", status is not None, (status or {}).get("state", ""))
    except Exception as e:  # noqa: BLE001
        log("NSE marketStatus", False, e)
    try:
        stocks = nse.stocks("NIFTY 500")
        log("NSE NIFTY 500 constituents", bool(stocks), f"{len(stocks)} stocks")
    except Exception as e:  # noqa: BLE001
        log("NSE NIFTY 500 constituents", False, e)

    headline, series = {}, {}
    for key, (sym, label, exch) in YAHOO_HEADLINE.items():
        try:
            quote, ser = yahoo_chart(yop, sym)
            headline[key] = {"label": label, "exchange": exch, **quote}
            series[key] = ser
            log(f"Yahoo {sym}", True, f"{len(ser)} points")
        except Exception as e:  # noqa: BLE001
            log(f"Yahoo {sym}", False, e)

    # If Yahoo failed for an NSE index, rebuild headline from NSE data.
    nse_by_name = {r["name"]: r for r in indices}
    for key, nse_name, label in (("nifty", "NIFTY 50", "Nifty 50"),
                                 ("banknifty", "NIFTY BANK", "Bank Nifty"),
                                 ("vix", "INDIA VIX", "India VIX")):
        r = nse_by_name.get(nse_name)
        if r and key not in headline:
            headline[key] = {"label": label, "exchange": "NSE", **{
                k: r.get(k) for k in ("last", "prevClose", "change", "pChange", "open",
                                      "high", "low", "yearHigh", "yearLow")}}
            series.setdefault(key, [])
    # Prefer NSE's own figures for NSE indices when both exist (closer to the source).
    for key, nse_name in (("nifty", "NIFTY 50"), ("banknifty", "NIFTY BANK"), ("vix", "INDIA VIX")):
        r, h = nse_by_name.get(nse_name), headline.get(key)
        if r and h:
            for k in ("last", "prevClose", "change", "pChange", "open", "high", "low",
                      "yearHigh", "yearLow"):
                if r.get(k) is not None:
                    h[k] = r[k]

    # BSE indices (best effort).
    for sym, label in YAHOO_BSE_INDICES:
        try:
            quote, _ = yahoo_chart(yop, sym, interval="1d", rng="5d")
            if quote.get("last") is None:
                raise RuntimeError("no price")
            indices.append({"name": label, "group": "bse", "exchange": "BSE", **quote,
                            "chg30d": None, "chg365d": None, "pe": None})
            log(f"Yahoo {sym}", True)
        except Exception as e:  # noqa: BLE001
            log(f"Yahoo {sym}", False, e)

    if not headline and not indices and not stocks:
        print("No data fetched from any source; not writing a snapshot.", file=sys.stderr)
        return 1

    # "Other" NSE indices are noise for this view; keep the groups we render.
    indices = [r for r in indices if r["group"] in ("broad", "sectoral", "thematic", "bse")
               or r["name"] == "INDIA VIX"]

    snapshot = {
        "generatedAt": now.isoformat(timespec="seconds"),
        "generatedEpoch": int(now.timestamp()),
        "marketStatus": status,
        "headline": headline,
        "series": series,
        "indices": indices,
        "breadth": build_breadth(stocks),
        "industries": build_industries(stocks),
        "movers": build_movers(stocks) if stocks else None,
        "diagnostics": diagnostics,
        "notes": "Public data, typically delayed. Not investment advice.",
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
