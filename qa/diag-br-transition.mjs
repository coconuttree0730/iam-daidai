/* [诊断] 右下区域乱跳 —— 动态过渡录制回路
 *
 * 背景：qa/verify-sprite-follow.mjs 是静态点测（每点等收敛后读帧），全部通过；
 *       但用户报"鼠标在右下区域移动时跟随混乱乱跳"。这是**过渡路径**问题，
 *       静态点测天生测不到。本脚本录制指针移动期间帧序号的时间线，
 *       把"乱跳"翻译成数字：一次过渡实际扫过多少个不同的帧。
 *
 * 场景：
 *   A. seam-cross     从人物正下方右侧横穿到左侧（跨首尾接缝 phi 0/360）
 *                     期望端点 45 → 0。若缓动把进度当线性轴而不是圆环，
 *                     会从 45 一路倒扫 44,43,…,1 到 0 —— 全片倒带即"乱跳"。
 *   B. deadzone-right 从人物右侧横穿进死区（矩形内 = 第 0 帧）
 *                     期望端点 34 → 0。
 *   C. br-within      右下象限内部两点（远离一切边界）—— 对照组，应平滑。
 *   D. jitter-seam    在接缝线上做 ±6px 手抖振荡 14 次 —— 模拟真实手感，
 *                     统计帧变化总次数与扫过的不同帧数。
 *
 * 判红（2026-09-11 起按"圆环最短路径"语义，与修复后的 animator 一致）：
 *   帧序是周长 frameCount 的圆环（帧 N−1 与帧 0 相邻），正确过渡 = 最短路径。
 *   A  ：接缝 45→0 最短路径 1 帧，扫过 > 6 帧判红（旧缺陷扫 24 帧）
 *   B  ：死区 34→0 最短路径 12 帧（经 35…45 绕回 0），扫过 > 16 帧判红（旧缺陷扫 20 帧）
 *   C  ：象限内 43→39 最短路径 4 帧，扫过 > 10 帧判红
 *   D  ：手抖振荡下扫过不同帧 > 6 或最长连续单调段 > 4 判红
 *        （修复后接缝两侧 45↔0 的快速翻转是契约行为，判据看"每次翻转扫几帧"而非次数）
 *
 * 用法：node qa/diag-br-transition.mjs
 * 退出码：0 = 全绿；1 = 有场景判红；2 = 环境不可用
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const SOCKET_SLACK = '/com.google.Chrome.XXXXXX/SingletonSocket'.length;
const CHROME_TMP =
  [process.env.FOLLOW_TMP, join(homedir(), '.tmp'), '/home/vii/.tmp', tmpdir()]
    .filter(Boolean)
    .map((base) => join(base, 'cdp-brdiag'))
    .find((dir) => {
      if (dir.length + SOCKET_SLACK >= 100) return false;
      try {
        mkdirSync(dir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    }) ?? null;
if (!CHROME_TMP) {
  console.error('找不到足够短且可写的 Chrome profile 目录');
  process.exit(2);
}

const VIEWPORT = { width: 1440, height: 900 };
const POLL_MS = 25; // 帧时间线采样间隔
const RECORD_MS = 1400; // 单次过渡录制时长
const HTTP_PORT = 8720 + (process.pid % 70);
const CDP_PORT = 9220 + (process.pid % 70);
const NAV_Q = `?v=${Date.now().toString(36)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(DIST, p);
      if (!file.startsWith(DIST) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
  return server;
}

async function startChrome() {
  mkdirSync(join(CHROME_TMP, 'crash'), { recursive: true });
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const logPath = join(ROOT, '.tmp', 'brdiag-chrome.log');
  const logFd = openSync(logPath, 'w');
  const proc = spawn(
    'google-chrome-stable',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-proxy-server',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--breakpad-dump-location=${join(CHROME_TMP, 'crash')}`,
      `--user-data-dir=${CHROME_TMP}`,
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', logFd], env: { ...process.env, TMPDIR: CHROME_TMP, HOME: CHROME_TMP } }
  );
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (proc.exitCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) {
        closeSync(logFd);
        return proc;
      }
    } catch {
      /* 还没起来 */
    }
  }
  proc.kill('SIGKILL');
  closeSync(logFd);
  const tail = await readFile(logPath, 'utf8').then(
    (t) => t.trim().split('\n').slice(-6).join('\n'),
    () => '(读不到日志)'
  );
  throw new Error(`Chrome 未就绪（exitCode=${proc.exitCode}）\n${tail}`);
}

async function connectCdp() {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 type=page 的 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve: res, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

const evaluate = async (send, expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`页面内求值抛错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
};

const indexFromBgPos = (bg, columns, rows) => {
  const [xp, yp] = bg.split(/\s+/).map(Number.parseFloat);
  if (!Number.isFinite(xp) || !Number.isFinite(yp)) return null;
  const col = Math.round((xp / 100) * (columns - 1));
  const row = Math.round((yp / 100) * (rows - 1));
  return row * columns + col;
};

const movePointer = (send, x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, button: 'none', clickCount: 0 });

/* 读帧一次 */
const readFrame = (send, cols, rows) =>
  evaluate(
    send,
    `getComputedStyle(document.querySelector('[data-sprite]')).backgroundPosition`
  ).then((bg) => indexFromBgPos(bg, cols, rows));

/* 等收敛（轮询到读数连续 3 次不变） */
async function settle(send, cols, rows) {
  const t0 = Date.now();
  let prev = null;
  let hits = 0;
  while (Date.now() - t0 < 4000) {
    const f = await readFrame(send, cols, rows);
    if (f !== null && f === prev) {
      if (++hits >= 2) return f;
    } else hits = 0;
    prev = f;
    await sleep(120);
  }
  return prev;
}

/* 录制过渡：派发 mouseMoved 后连续采样帧时间线 */
async function recordTransition(send, cols, rows, from, to) {
  await movePointer(send, from.x, from.y);
  const startFrame = await settle(send, cols, rows);
  await movePointer(send, to.x, to.y);
  const timeline = [];
  const t0 = Date.now();
  while (Date.now() - t0 < RECORD_MS) {
    timeline.push(await readFrame(send, cols, rows));
    await sleep(POLL_MS);
  }
  const endFrame = timeline[timeline.length - 1];
  const visited = [...new Set(timeline.filter((f) => f !== null))];
  /* 最长连续单调段（判定"倒带"形态） */
  let maxRun = 0;
  let run = 0;
  let dir = 0;
  for (let i = 1; i < timeline.length; i++) {
    const d = Math.sign(timeline[i] - timeline[i - 1]);
    if (d !== 0 && d === dir) run++;
    else {
      run = d !== 0 ? 1 : 0;
      dir = d;
    }
    if (run > maxRun) maxRun = run;
  }
  return { startFrame, endFrame, visited, visitedCount: visited.length, maxMonotonicRun: maxRun + 1, timeline };
}

const main = async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先 npm run build');
  const server = await startServer();
  let chrome = null;
  let ws = null;
  const failures = [];
  try {
    chrome = await startChrome();
    const cdp = await connectCdp();
    ws = cdp.ws;
    const { send } = cdp;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html${NAV_Q}` });
    await sleep(1800);
    await evaluate(send, 'window.scrollTo(0,0); document.fonts.ready');

    const geom = await evaluate(
      send,
      `(() => {
         const view = document.querySelector('[data-sprite-view]');
         const el = view.querySelector('[data-sprite]');
         const r = el.getBoundingClientRect();
         const raw = String(view.dataset.personInset || '').trim();
         const ins = raw.split(/\\s+/).map(Number);
         const ok = ins.length === 4 && ins.every((n) => Number.isFinite(n));
         const i = ok ? ins : [0, 0, 0, 0];
         return {
           rect: {
             left: r.left + r.width * i[0], top: r.top + r.height * i[1],
             width: r.width * (1 - i[0] - i[2]), height: r.height * (1 - i[1] - i[3]),
           },
           columns: Number(view.dataset.columns), rows: Number(view.dataset.rows),
           frameCount: Number(view.dataset.frameCount),
         };
       })()`
    );
    const { rect, columns, rows, frameCount } = geom;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const H = VIEWPORT.height;
    console.log(`=== 几何 ===`);
    console.log(`人物矩形 ${rect.left.toFixed(1)},${rect.top.toFixed(1)} ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}  中心(${cx.toFixed(1)},${cy.toFixed(1)})  底边下缝隙 ${(H - (rect.top + rect.height)).toFixed(1)}px`);

    const yBottom = H - 4; // 人物底边之下的窄缝
    const scenarios = [
      {
        name: 'A-seam-cross',
        desc: '正下方横穿接缝（BR 尾帧侧 → BL 首帧侧），最短路径 1 帧',
        from: { x: Math.round(cx + 40), y: yBottom },
        to: { x: Math.round(cx - 40), y: yBottom },
        judge: (r) => (r.visitedCount > 6 ? `倒带：一次过渡扫过 ${r.visitedCount} 个不同帧（最短路径 1）` : null),
      },
      {
        name: 'B-deadzone-right',
        desc: '从人物右侧横穿进死区，最短路径 12 帧（34→45→0）',
        from: { x: Math.round(rect.left + rect.width + 60), y: Math.round(cy) },
        to: { x: Math.round(rect.left + rect.width - 20), y: Math.round(cy) },
        judge: (r) => (r.visitedCount > 16 ? `倒带：一次过渡扫过 ${r.visitedCount} 个不同帧（最短路径 12）` : null),
      },
      {
        name: 'C-br-within',
        desc: '右下象限内部两点（对照组），最短路径 4 帧',
        from: { x: Math.round(cx + 250), y: Math.round(cy + 240) },
        to: { x: Math.round(cx + 340), y: Math.round(cy + 150) },
        judge: (r) => (r.visitedCount > 10 ? `象限内过渡扫过 ${r.visitedCount} 个不同帧（最短路径 4）` : null),
      },
      {
        name: 'D-jitter-seam',
        desc: '接缝线上 ±6px 手抖振荡 14 次',
        jitter: true,
        judge: (r) =>
          r.visitedCount > 6 || r.maxMonotonicRun > 4
            ? `手抖即倒带：扫过 ${r.visitedCount} 个不同帧，最长单调段 ${r.maxMonotonicRun}`
            : null,
      },
    ];

    const results = [];
    for (const sc of scenarios) {
      if (sc.jitter) {
        await movePointer(send, Math.round(cx + 6), yBottom);
        const base = await settle(send, columns, rows);
        const timeline = [];
        const t0 = Date.now();
        let k = 0;
        while (Date.now() - t0 < 14 * 130) {
          const x = Math.round(cx + (k % 2 === 0 ? -6 : 6));
          await movePointer(send, x, yBottom);
          timeline.push(await readFrame(send, columns, rows));
          await sleep(60);
          k++;
        }
        let changeCount = 0;
        for (let i = 1; i < timeline.length; i++) {
          if (timeline[i] !== timeline[i - 1]) changeCount++;
        }
        /* 最长连续单调段：修复后每次翻转只走 1 帧；旧缺陷每次翻转倒带 3+ 帧 */
        let maxRun = 0;
        let run = 0;
        let dir = 0;
        for (let i = 1; i < timeline.length; i++) {
          const d = Math.sign(timeline[i] - timeline[i - 1]);
          if (d !== 0 && d === dir) run++;
          else {
            run = d !== 0 ? 1 : 0;
            dir = d;
          }
          if (run > maxRun) maxRun = run;
        }
        const visited = [...new Set(timeline.filter((f) => f !== null))];
        const r = { startFrame: base, endFrame: timeline[timeline.length - 1], visited, visitedCount: visited.length, changeCount, maxMonotonicRun: maxRun + 1, timeline };
        const bad = sc.judge(r);
        if (bad) failures.push(`${sc.name}: ${bad}`);
        results.push({ ...sc, result: { ...r, timeline: undefined } });
        console.log(`\n--- ${sc.name}: ${sc.desc} ---`);
        console.log(`    起始帧 ${base}  帧变化 ${changeCount} 次  扫过不同帧 ${visited.length} 个: ${visited.join(',')}`);
        continue;
      }
      const r = await recordTransition(send, columns, rows, sc.from, sc.to);
      const bad = sc.judge(r);
      if (bad) failures.push(`${sc.name}: ${bad}`);
      results.push({ ...sc, result: { ...r, timeline: undefined } });
      console.log(`\n--- ${sc.name}: ${sc.desc} ---`);
      console.log(`    ${JSON.stringify(sc.from)} → ${JSON.stringify(sc.to)}`);
      console.log(`    起始帧 ${r.startFrame} → 结束帧 ${r.endFrame}  扫过不同帧 ${r.visitedCount} 个`);
      console.log(`    路径: ${r.visited.join(',')}`);
      console.log(`    最长连续单调段: ${r.maxMonotonicRun} 帧采样点`);
    }

    await writeFile(
      join(ROOT, 'qa', 'out', 'br-transition-report.json'),
      JSON.stringify({ geom, results, failures }, null, 2)
    );
    console.log(`\n报告: qa/out/br-transition-report.json`);
    if (failures.length) {
      console.log(`\n✗ 判红 ${failures.length} 项：`);
      failures.forEach((f) => console.log(`  · ${f}`));
      process.exitCode = 1;
    } else {
      console.log('\n✓ 全部场景通过');
    }
  } finally {
    try {
      ws?.close();
    } catch {}
    chrome?.kill('SIGKILL');
    await new Promise((r) => server.close(r));
  }
};

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(2);
  }
);
