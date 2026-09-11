#!/bin/zsh
# 背景漂移诊断：起静态服务 → 起 Chrome → 采样 → 收尾
# 用法：zsh qa/run-bg-drift.sh [W] [H]
set -u
ROOT="/home/vii/Projects/workspace-dev/my-project/my/iam-daidai"
W="${1:-1440}"
H="${2:-900}"
export TMPDIR="$ROOT/.tmp"
mkdir -p "$TMPDIR/crash" "$TMPDIR/cdp-drift"
export ASTRO_TELEMETRY_DISABLED=1

HTTP_PORT=8901
CDP_PORT=9350

cd "$ROOT/dist" || exit 1
python3 -m http.server $HTTP_PORT --bind 127.0.0.1 > "$TMPDIR/http-drift.log" 2>&1 &
HTTP_PID=$!
sleep 2
CODE=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" "http://127.0.0.1:$HTTP_PORT/index.html")
if [ "$CODE" != "200" ]; then echo "静态服务未就绪 (code=$CODE)"; kill $HTTP_PID 2>/dev/null; exit 2; fi

google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --no-proxy-server \
  --breakpad-dump-location="$TMPDIR/crash" \
  --user-data-dir="$TMPDIR/cdp-drift" \
  --remote-debugging-port=$CDP_PORT about:blank > "$TMPDIR/cdp-drift.log" 2>&1 &
CHROME_PID=$!

# 轮询 Chrome 就绪（不固定 sleep）
for i in $(seq 1 30); do
  sleep 1
  if curl -s --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | grep -q Browser; then
    echo "Chrome 就绪 :$CDP_PORT"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "Chrome 未就绪"; tail -5 "$TMPDIR/cdp-drift.log"
    kill $CHROME_PID $HTTP_PID 2>/dev/null; exit 2
  fi
done

cd "$ROOT" || exit 1
CDP_PORT=$CDP_PORT node qa/diag-bg-drift.mjs "http://127.0.0.1:$HTTP_PORT/index.html" qa/out "$W" "$H"
STATUS=$?

kill $CHROME_PID 2>/dev/null
kill $HTTP_PID 2>/dev/null
wait 2>/dev/null
exit $STATUS
