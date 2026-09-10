#!/bin/zsh
# 一次性跑完：静态服务 → Chrome/CDP → 多视口诊断
# /tmp 是 10M tmpfs，必须把 TMPDIR 指到项目内
set -u
ROOT="/home/vii/Projects/workspace-dev/my-project/my/iam-daidai"
export TMPDIR="$ROOT/.tmp"
mkdir -p "$TMPDIR/crash" "$TMPDIR/cdp-diag"
export ASTRO_TELEMETRY_DISABLED=1

HTTP_PORT=8901
CDP_PORT=9347

cd "$ROOT/dist" || exit 1
python3 -m http.server $HTTP_PORT --bind 127.0.0.1 > "$TMPDIR/http.log" 2>&1 &
HTTP_PID=$!
sleep 2
CODE=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" "http://127.0.0.1:$HTTP_PORT/index.html")
if [ "$CODE" != "200" ]; then echo "静态服务未就绪 (code=$CODE)"; kill $HTTP_PID 2>/dev/null; exit 1; fi
echo "静态服务就绪 :$HTTP_PORT"

google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --disable-dev-shm-usage \
  --breakpad-dump-location="$TMPDIR/crash" \
  --user-data-dir="$TMPDIR/cdp-diag" \
  --remote-debugging-port=$CDP_PORT about:blank > "$TMPDIR/cdp.log" 2>&1 &
CHROME_PID=$!
sleep 6
curl -s --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" | grep -q Browser \
  || { echo "Chrome 调试端口未就绪"; tail -5 "$TMPDIR/cdp.log"; kill $CHROME_PID $HTTP_PID 2>/dev/null; exit 1; }

cd "$ROOT" || exit 1
STATUS=0
for spec in "$@"; do
  W="${spec%x*}"; H="${spec#*x}"
  CDP_PORT=$CDP_PORT node qa/diag-layers.mjs "http://127.0.0.1:$HTTP_PORT/index.html" qa/out "$W" "$H" || STATUS=1
done

kill $CHROME_PID 2>/dev/null
kill $HTTP_PID 2>/dev/null
wait 2>/dev/null
exit $STATUS
