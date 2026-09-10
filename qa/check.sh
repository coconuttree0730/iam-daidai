#!/bin/zsh
# 多视口几何检查：一次进程内起服务 + Chrome，循环调用 check-geometry.mjs
set -u
ROOT="/home/vii/Projects/workspace-dev/my-project/my/iam-daidai"
export TMPDIR="$ROOT/.tmp"
mkdir -p "$TMPDIR/crash" "$TMPDIR/cdp-geo"
export ASTRO_TELEMETRY_DISABLED=1

HTTP_PORT=8902
CDP_PORT=9348

cd "$ROOT/dist" || exit 1
python3 -m http.server $HTTP_PORT --bind 127.0.0.1 > "$TMPDIR/http2.log" 2>&1 &
HTTP_PID=$!
sleep 2

google-chrome-stable --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --breakpad-dump-location="$TMPDIR/crash" \
  --user-data-dir="$TMPDIR/cdp-geo" \
  --remote-debugging-port=$CDP_PORT about:blank > "$TMPDIR/cdp2.log" 2>&1 &
CHROME_PID=$!
sleep 6
curl -s --noproxy '*' "http://127.0.0.1:$CDP_PORT/json/version" | grep -q Browser \
  || { echo "Chrome 未就绪"; tail -5 "$TMPDIR/cdp2.log"; kill $CHROME_PID $HTTP_PID 2>/dev/null; exit 1; }

cd "$ROOT" || exit 1
FAIL=0
for spec in "$@"; do
  W="${spec%x*}"; H="${spec#*x}"
  # ?v=... 必须带：--user-data-dir 是常驻的，index.html 会被 Chrome 的 HTTP 缓存
  # 记住，于是即使 dist 已经重建，页面仍引用**上一版**的 index.<hash>.css，
  # 检查全部基于旧版式（实测 901x800 会报出 70vh 的旧 --design-h）。
  # 查询串变了 → index.html 重新取 → 它引用的 CSS 指纹也跟着变。
  CDP_PORT=$CDP_PORT node qa/check-geometry.mjs \
    "http://127.0.0.1:$HTTP_PORT/index.html?v=${W}x${H}-$(date +%s)" "$W" "$H" || FAIL=1
done

kill $CHROME_PID 2>/dev/null
kill $HTTP_PID 2>/dev/null
wait 2>/dev/null
echo "\n(出屏/压字任一非空即为 FAIL=$FAIL)"
exit $FAIL
