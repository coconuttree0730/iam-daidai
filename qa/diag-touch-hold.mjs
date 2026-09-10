/* 触摸点卡 → 人物姿态保持 诊断/回归
 *
 * 契约（独立实现，不 import 被测代码）：
 *   T1 点上方左侧卡片 → 帧进入左上象限带（46 帧 ≈ 10–26）并**保持**，不弹回第 0 帧
 *   T2 点上方右侧卡片 → 帧进入右上象限带（46 帧 ≈ 20–36）并保持
 *   判"保持" = tap 后 2.5s 内最后一次采样仍在带内，且采样序列末段连续 5 次 > 0
 *
 * 用法： node qa/diag-touch-hold.mjs [--w=390 --h=844]
 * 退出码：0 = 通过；1 = 断言失败（红）；2 = 环境不可用
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const W = Number(argv.w ?? 390);
const H = Number(argv.h ?? 844);
setTimeout(() => { console.error('[watchdog] 90s 总超时，强退'); process.exit(3); }, 90000).unref();
const PORT = 8970 + (process.pid % 20);
const CDP_PORT = 9470 + (process.pid % 20);
const NAV_Q = `?v=${Date.now().toString(36)}`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = join(DIST, p);
  if (!existsSync(fp)) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('content-type', MIME[extname(fp)] || 'application/octet-stream');
  console.error('[srv]', req.url);
  readFile(fp).then((b) => res.end(b));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const PROFILE = '/home/vii/.tmp/cdp-touch-hold';
mkdirSync(join(PROFILE, 'crash'), { recursive: true });
const chromeLog = join(PROFILE, 'chrome.log');
const NAV_URL = `http://127.0.0.1:${PORT}/${NAV_Q}`;
const chrome = spawn('google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-proxy-server', '--hide-scrollbars',
  `--breakpad-dump-location=${join(PROFILE, 'crash')}`,
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${W},${H}`, 'about:blank',
], { env: { ...process.env, TMPDIR: PROFILE, HOME: PROFILE }, stdio: ['ignore', 'ignore', openSync(chromeLog, 'w')] });

let list = null;
for (let i = 0; i < 40; i++) {
  try { list = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json()); break; }
  catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (!list) { console.error('CDP 不可达'); chrome.kill(); server.close(); process.exit(2); }

/* 页面级 WS，与 verify-sprite-follow.connectCdp 同款 */
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
ws.onclose = (e) => console.error('[ws] closed code=', e.code, 'reason=', e.reason);
ws.onerror = (e) => console.error('[ws] error', e.error?.message ?? e.message ?? '(no msg)');
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let mid = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}); console.error('[timeout]', method); } }, 8000);
});
const evalJson = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) console.error('[eval-err]', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const evalWithTimeout = (expr) => Promise.race([
  evalJson(expr),
  new Promise((r) => setTimeout(() => r(null), 8000)),
]);

await send('Page.enable');
if (!argv.noemul) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}
await send('Page.navigate', { url: NAV_URL });
for (let i = 0; i < 40; i++) {
  const ready = await evalWithTimeout(`!!document.querySelector('[data-sprite]')`);
  if (ready) break;
  await sleep(250);
}
console.error('[step] page ready');

/* 几何与期望（独立实现）：人物矩形 = [data-sprite] 盒按 data-person-inset 内缩 */
const geo = await evalJson(`(() => {
  const view = document.querySelector('[data-sprite-view]');
  const sp = view.querySelector('[data-sprite]');
  const b = sp.getBoundingClientRect();
  const raw = String(view.dataset.personInset || '').trim();
  const ins = raw ? raw.split(/\\s+/).map(Number) : [];
  const safe = (v) => (Number.isFinite(v) && v >= 0 && v < 1 ? v : 0);
  const l = safe(ins[0]), t = safe(ins[1]), r = safe(ins[2]), bo = safe(ins[3]);
  const rect = { left: b.left + b.width * l, top: b.top + b.height * t,
                 width: b.width * (1 - l - r), height: b.height * (1 - t - bo) };
  const cards = [1, 2, 3, 4].map((n) => {
    const q = view.querySelector('.card:nth-child(' + n + ')').getBoundingClientRect();
    return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
  });
  return { rect, cards,
           cols: Number(view.dataset.columns), rows: Number(view.dataset.rows) };
})()`);
console.log('personRect', JSON.stringify(geo.rect));

/* 帧 = background-position 百分比反推（与 motion.js 同一公式，但独立换算） */
const readFrame = async () => {
  const v = await evalJson(`(() => {
    const cs = getComputedStyle(document.querySelector('[data-sprite]'));
    return cs.backgroundPosition + '|' + cs.backgroundSize;
  })()`);
  const [pos, size] = v.split('|');
  const px = pos.split(' ').map(parseFloat);
  const sw = size.split(' ').map(parseFloat);
  const col = Math.round((px[0] / 100) * (geo.cols - 1));
  const row = Math.round((px[1] / 100) * (geo.rows - 1));
  return row * geo.cols + col;
};

const tap = async (x, y) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

/* 采样 2.5s，每 100ms 一次 */
const timeline = async (label) => {
  const frames = [];
  for (let i = 0; i < 25; i++) { frames.push(await readFrame()); await sleep(100); }
  console.log(label, frames.join(','));
  return frames;
};

const frameCount = geo.cols * geo.rows; // 上限，仅用于带宽换算
const BAND = { TL: [10, 26], TR: [20, 36] }; // 46 帧：TL=12–22、TR=23–34，放宽容错 warp
const run = async (cardIdx, band) => {
  const c = geo.cards[cardIdx];
  await tap(c.x, c.y);
  const frames = await timeline(`tap card-0${cardIdx + 1} →`);
  const tail = frames.slice(-6);
  const held = tail.every((f) => f >= band[0] && f <= band[1]);
  const reached = frames.some((f) => f >= band[0] && f <= band[1]);
  const ok = reached && held;
  console.log(`  象限带 ${band} 进入=${reached} 保持=${held} → ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
};

const r1 = await run(0, BAND.TL);
const r2 = await run(3, BAND.TR);

ws.close(); chrome.kill(); server.close();
const failed = !(r1 && r2);
console.log(failed ? 'RED：触摸点卡后姿态未保持/未进入正确象限' : 'GREEN：点卡跟踪并保持');
process.exit(failed ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
