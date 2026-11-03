#!/usr/bin/env bash
# Preview the UI with SYNTHETIC data (never use for anything real).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tests/mock_server.py 8765 >/dev/null 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
sleep 1
NO_PROXY=127.0.0.1 NSE_BASE=http://127.0.0.1:8765 YAHOO_BASE=http://127.0.0.1:8765 \
  python3 collector/collect.py docs/data/snapshot.json
python3 - <<'PY'
import json
p = "docs/data/snapshot.json"
d = json.load(open(p)); d["demo"] = True
json.dump(d, open(p, "w"), separators=(",", ":"))
PY
echo "Synthetic snapshot written. Serving http://localhost:8000"
python3 -m http.server -d docs 8000
