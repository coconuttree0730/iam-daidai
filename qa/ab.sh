#!/bin/zsh
# 立绘清晰度受控 A/B：静态服务 → Chrome/CDP → ab-figure.mjs
set -u
ROOT="/home/vii/Projects/workspace-dev/my-project/my/iam-daidai"
export TMPDIR="$ROOT/.tmp"
mkdir -p "$TMPDIR/crash" "$TMPDIR/cdp-ab"
export ASTRO_TELEMETRY_DISABLED=1

HTTP_PORT=8903
CDP_PORT=9349

cd "$ROOT/dist" || exit 1
python3 -m http.server $HTTP_PORT --bind 127.0.0.1 > "$TMPDIR/http3.log" 2>&1 &
HTTP_PID=$!
sleep 2

google-chrome-stable --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --breakpad-dump-location="$TMPDIR/crash" \
  --user-data-dir="$TMPDIR/cdp-ab" \
  --remote-debugging-port=$CDP_PORT about:blank > "$TMPDIR/cdp3.log" 2>&1 &
CHROME_PID=$!
sleep 6
curl -s --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" | grep -q Browser \
  || { echo "Chrome 未就绪"; tail -5 "$TMPDIR/cdp3.log"; kill $CHROME_PID $HTTP_PID 2>/dev/null; exit 1; }

cd "$ROOT" || exit 1
W="${1%x*}"; H="${1#*x}"
CDP_PORT=$CDP_PORT node qa/ab-figure.mjs "http://127.0.0.1:$HTTP_PORT/index.html" "$W" "$H" "${2:-910px}"

kill $CHROME_PID 2>/dev/null
kill $HTTP_PID 2>/dev/null
wait 2>/dev/null
