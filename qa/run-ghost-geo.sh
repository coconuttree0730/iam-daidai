#!/bin/zsh
set -u
ROOT="/home/vii/Projects/workspace-dev/my-project/my/iam-daidai"
W="${1:-1080}"; H="${2:-608}"
export TMPDIR="$ROOT/.tmp"; mkdir -p "$TMPDIR/crash" "$TMPDIR/cdp-gg"
export ASTRO_TELEMETRY_DISABLED=1
HTTP_PORT=8905; CDP_PORT=9354
cd "$ROOT/dist" || exit 1
python3 -m http.server $HTTP_PORT --bind 127.0.0.1 > "$TMPDIR/http-gg.log" 2>&1 &
HTTP_PID=$!; sleep 2
curl -s --noproxy '*' -o /dev/null -w "%{http_code}" "http://127.0.0.1:$HTTP_PORT/index.html" | grep -q 200 || { echo "静态服务未就绪"; kill $HTTP_PID; exit 2; }
google-chrome-stable --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-proxy-server \
  --breakpad-dump-location="$TMPDIR/crash" --user-data-dir="$TMPDIR/cdp-gg" \
  --remote-debugging-port=$CDP_PORT about:blank > "$TMPDIR/cdp-gg.log" 2>&1 &
CHROME_PID=$!
for i in $(seq 1 30); do sleep 1
  curl -s --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | grep -q Browser && break
  [ $i -eq 30 ] && { echo "Chrome 未就绪"; kill $CHROME_PID $HTTP_PID; exit 2; }
done
cd "$ROOT"; CDP_PORT=$CDP_PORT node qa/diag-ghost-geo.mjs "http://127.0.0.1:$HTTP_PORT/index.html" qa/out "$W" "$H"
STATUS=$?; kill $CHROME_PID $HTTP_PID 2>/dev/null; wait 2>/dev/null; exit $STATUS
