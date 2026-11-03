#!/usr/bin/env python3
"""Local mock of the NSE / Yahoo response *shapes* the collector expects.

Numbers are synthetic and exist only to exercise the pipeline and the UI.
They are never published: the Pages workflow runs the real collector.

Usage: python mock_server.py [port]
"""
import json
import math
import random
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

random.seed(7)

IDX = [
    # name, key, last, pct
    ("NIFTY 50", "BROAD MARKET INDICES", 24310.4, 0.42),
    ("NIFTY NEXT 50", "BROAD MARKET INDICES", 69840.1, 0.15),
    ("NIFTY 100", "BROAD MARKET INDICES", 25120.3, 0.38),
    ("NIFTY 200", "BROAD MARKET INDICES", 13480.9, 0.33),
    ("NIFTY 500", "BROAD MARKET INDICES", 22410.2, 0.29),
    ("NIFTY MIDCAP 100", "BROAD MARKET INDICES", 56210.7, -0.21),
    ("NIFTY SMALLCAP 250", "BROAD MARKET INDICES", 16890.5, -0.64),
    ("NIFTY BANK", "SECTORAL INDICES", 53280.6, 0.88),
    ("NIFTY IT", "SECTORAL INDICES", 36120.4, -1.12),
    ("NIFTY AUTO", "SECTORAL INDICES", 25940.2, 1.31),
    ("NIFTY PHARMA", "SECTORAL INDICES", 21980.9, -0.35),
    ("NIFTY METAL", "SECTORAL INDICES", 9870.3, 0.52),
    ("NIFTY FMCG", "SECTORAL INDICES", 55400.1, 0.07),
    ("NIFTY REALTY", "SECTORAL INDICES", 940.8, -1.74),
    ("NIFTY PSU BANK", "SECTORAL INDICES", 7120.5, 1.92),
    ("NIFTY ENERGY", "SECTORAL INDICES", 35210.0, 0.61),
    ("NIFTY INDIA DEFENCE", "THEMATIC INDICES", 8210.0, 2.4),
    ("INDIA VIX", "OTHERS", 13.8, -3.4),
]
SECT = ["Financial Services", "Information Technology", "Automobile", "Healthcare", "Metals & Mining",
        "Fast Moving Consumer Goods", "Oil Gas & Consumable Fuels", "Realty", "Capital Goods", "Power"]


def idx_rows():
    out = []
    for n, k, last, p in IDX:
        prev = last / (1 + p / 100)
        out.append({
            "key": k, "index": n, "indexSymbol": n, "last": last, "variation": round(last - prev, 2),
            "percentChange": p, "open": round(prev * 1.001, 2), "high": round(max(last, prev) * 1.004, 2),
            "low": round(min(last, prev) * 0.996, 2), "previousClose": round(prev, 2),
            "yearHigh": round(last * 1.09, 2), "yearLow": round(last * 0.78, 2),
            "advances": random.randint(5, 40), "declines": random.randint(5, 40), "unchanged": 1,
            "pe": round(random.uniform(14, 34), 2), "pb": 3.1, "dy": 1.2,
            "perChange30d": round(random.uniform(-4, 6), 2), "perChange365d": round(random.uniform(-8, 24), 2),
        })
    return out


def stock_rows():
    rows = [{"priority": 1, "symbol": "NIFTY 500", "lastPrice": 22410.2}]
    for i in range(500):
        price = round(random.uniform(40, 4200), 2)
        p = round(random.gauss(0.25, 1.4), 2)
        prev = price / (1 + p / 100)
        yh, yl = price * random.uniform(1.0, 1.6), price * random.uniform(0.55, 1.0)
        rows.append({
            "priority": 0, "symbol": f"STK{i:03d}", "lastPrice": price, "change": round(price - prev, 2),
            "pChange": p, "open": price, "dayHigh": price * 1.01, "dayLow": price * 0.99,
            "previousClose": round(prev, 2), "totalTradedVolume": random.randint(20000, 40000000),
            "totalTradedValue": random.uniform(5e7, 6e10), "yearHigh": round(yh, 2), "yearLow": round(yl, 2),
            "meta": {"companyName": f"Mock Company {i:03d} Ltd", "industry": random.choice(SECT)},
        })
    return rows


def chart(sym):
    base = {"^NSEI": 24310.4, "^BSESN": 79820.7, "^NSEBANK": 53280.6, "^INDIAVIX": 13.8}.get(sym, 1000.0)
    prev = base / 1.004
    day = int(time.time()) // 86400 * 86400 - 19800 + 86400 * 0  # IST midnight-ish
    start = day + 9 * 3600 + 15 * 60 - 19800 + 19800
    ts, cl, v = [], [], prev
    for i in range(0, 76):
        v += random.gauss(0.0004 * prev / 20, 0.0012 * prev) * (0.6 if i else 0)
        ts.append(start + i * 300)
        cl.append(round(v, 2))
    cl[-1] = round(base, 2)
    return {"chart": {"result": [{
        "meta": {"regularMarketPrice": base, "chartPreviousClose": round(prev, 2), "previousClose": round(prev, 2),
                 "regularMarketDayHigh": max(cl), "regularMarketDayLow": min(cl),
                 "fiftyTwoWeekHigh": base * 1.08, "fiftyTwoWeekLow": base * 0.8, "regularMarketTime": ts[-1]},
        "timestamp": ts, "indicators": {"quote": [{"close": cl}]}}], "error": None}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p in ("/", "/market-data/live-equity-market"):
            return self.send(b"<html></html>", "text/html")
        if p == "/api/allIndices":
            return self.send({"data": idx_rows()})
        if p == "/api/marketStatus":
            return self.send({"marketState": [{"market": "Capital Market", "marketStatus": "Open",
                                               "marketStatusMessage": "Normal Market is Open",
                                               "tradeDate": "04-Nov-2026"}]})
        if p == "/api/equity-stockIndices":
            return self.send({"data": stock_rows()})
        if p.startswith("/v8/finance/chart/"):
            sym = urllib.parse.unquote(p.rsplit("/", 1)[1])
            if sym.startswith("BSE-SMLCAP"):  # exercise the failure path
                self.send_response(404)
                self.end_headers()
                return
            return self.send(chart(sym))
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    HTTPServer(("127.0.0.1", port), H).serve_forever()
