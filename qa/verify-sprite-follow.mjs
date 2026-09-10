/* 帧随动验收：指针坐标 → 帧序号 的映射是否符合交互契约
 *
 * 交互契约（本文件的断言依据，与被测代码无关地独立实现）：
 *   1) **人物图片区域矩形**内 → 第 0 帧（正面待机姿态）。
 *      矩形 = 立绘元素盒按 data-person-inset（"左 上 右 下"，0–1 分数）内缩。
 *   2) 矩形外，以矩形中心为极点按方向角分四象限，顺时针依次为：
 *        左下 = 前 1/4 段  →  左上 = 第二段  →  右上 = 第三段  →  右下 = 第四段
 *      即 BL < TL < TR < BR，四段等长。
 *   3) **每个象限的可用角度按该象限自身可达范围归一化**，铺满它那 1/4 帧序。
 *      本文件的"段端点断言"守的就是这一条。只按 phi/360 线性映射时，人物矩形
 *      底边贴着视口底边会让"正下方"整条方向被死区占满，于是左下达不到段首、
 *      右下达不到段尾——全片 46 帧有 10 帧永远播不到。而"象限带"断言和
 *      "帧序递增"断言对此**全部免疫**，只有直接检查端点帧才能抓住。
 *   4) 同一坐标重复到达 → 同一帧；不同象限 → 渲染像素不同（不只是读数不同）
 *
 * 用法（在项目根目录下）：
 *   node qa/verify-sprite-follow.mjs                # 自起静态服务 + Chrome，一个进程内跑完
 *   node qa/verify-sprite-follow.mjs --out=qa/out
 *   node qa/verify-sprite-follow.mjs --w=1920 --h=1080
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境不可用（服务/Chrome/CDP 起不来）
 *
 * 环境注意：
 *   · /tmp 常是小容量 tmpfs，必须让 Chrome 的 TMPDIR 落在工作区
 *   · 工具调用结束后常驻进程会被回收 → 服务与 Chrome 都由本进程 spawn 并收尾
 *   · 环境可能设了全局 HTTP_PROXY，它会接管 127.0.0.1 → Chrome 加 --no-proxy-server
 *   · --user-data-dir 会常驻 HTTP 缓存，导致 dist 重建后仍取到旧 index.html
 *     → 导航 URL 必须带 cache-busting 查询串（下方 NAV_Q）
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
const TMP = join(ROOT, '.tmp', 'follow-verify');

/* Chrome 的 --user-data-dir 里会建 SingletonSocket（Unix domain socket），
 * 路径硬上限 108 字节。项目路径一深就撞：
 *   FATAL ... Socket path too long: .../com.google.Chrome.XXXXXX/SingletonSocket
 * 进程立刻死掉，紧接着 crashpad 报 "ptrace: Operation not permitted"——
 * 极易被误判成"沙箱禁 ptrace / chromium 起不来"。所以 profile 必须落在短路径上。
 * 先短后长逐个试，取第一个可写且拼出 socket 路径不超限的。 */
const SOCKET_SLACK = '/com.google.Chrome.XXXXXX/SingletonSocket'.length;
const CHROME_TMP =
  [
    process.env.FOLLOW_TMP,
    join(homedir(), '.tmp'),
    '/home/vii/.tmp',
    tmpdir(),
    join(ROOT, '.tmp'),
  ]
    .filter(Boolean)
    .map((base) => join(base, 'cdp-follow'))
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
  console.error('找不到足够短且可写的临时目录放 Chrome profile（socket 路径上限 108 字节）');
  process.exit(2);
}

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const OUT = resolve(ROOT, String(argv.out ?? 'qa/out'));
const CHROME = process.env.CHROME_BIN ?? 'google-chrome-stable';

const VIEWPORT = { width: Number(argv.w ?? 1440), height: Number(argv.h ?? 900) };
/* 收敛等待用**轮询到读数稳定**，不用固定 sleep。
 * createFrameAnimator 的 maxSpeed = frameCount × 2（46 帧 → 92 帧/秒），
 * 从第 0 帧跳到第 45 帧要 ~0.49s 再加指数尾巴；固定等 520ms 会测到 42 这样的
 * 中间值，把"没等够"误报成"映射错"。 */
const STABLE_POLL_MS = 120;
const STABLE_HITS = 3;
const SETTLE_TIMEOUT_MS = 4000;
const HTTP_PORT = Number(process.env.HTTP_PORT ?? (8900 + (process.pid % 90)));
const CDP_PORT = Number(process.env.CDP_PORT ?? (9400 + (process.pid % 90)));
/** 探针相对人物矩形边缘外推的距离 */
const PAD = 90;
const NAV_Q = `?v=${Date.now().toString(36)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

/* ── 契约的独立实现 ──────────────────────────────────────────────────────
 * 断言不复用被测代码的公式，否则测的是"自己等于自己"。这里从契约文字单独写出：
 * 起于正下方（左下与右下的分界），顺时针经左 → 上 → 右，一圈把 [0, frameCount-1]
 * 线性扫满，四象限各占四分之一。
 */
const phiOf = (x, y, rect) => {
  const deg =
    (Math.atan2(y - (rect.top + rect.height / 2), x - (rect.left + rect.width / 2)) * 180) /
    Math.PI;
  return (((deg - 90) % 360) + 360) % 360;
};

const insideRect = (x, y, rect) =>
  x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;

/* 契约 3) 的独立实现：四象限 + 可达角度归一化。
   射线-矩形求交自己写一遍，不 import 被测模块——否则测的是"自己等于自己"。 */
const QUAD_SEQ = ['BL', 'TL', 'TR', 'BR'];
const QUAD_BASE = [0, 90, 180, 270];

function rayInterval(ox, oy, dx, dy, r) {
  let t0 = 0;
  let t1 = Infinity;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    const a = (lo - o) / d;
    const b = (hi - o) / d;
    if (Math.min(a, b) > t0) t0 = Math.min(a, b);
    if (Math.max(a, b) < t1) t1 = Math.max(a, b);
    return true;
  };
  if (!slab(ox, dx, r.left, r.left + r.width)) return null;
  if (!slab(oy, dy, r.top, r.top + r.height)) return null;
  return t1 >= t0 ? [t0, t1] : null;
}

/** 页内射线上「死区之外」最长的一段长度 */
function outsideRun(inPage, inRect) {
  if (!inRect) return inPage[1] - inPage[0];
  return Math.max(inRect[0] - inPage[0], inPage[1] - inRect[1], 0);
}

/** 每象限内相对角 (0–90) 的可达区间。
 *  阈值 2% 长边与被测模块同源（见 src/lib/pointer-frame.js 的 MIN_RUN_RATIO）：
 *  不设阈值时，死区下方那条透明垫高度的窄缝会让"正下方"判成可达，
 *  四个象限都算满 0–90°，归一化失效——端点断言正是为此存在。 */
const MIN_RUN_RATIO = 0.02;

function reachableSpans(rect, page, steps = 1440) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const minRun = Math.max(1, Math.max(rect.width, rect.height) * MIN_RUN_RATIO);
  const spans = {};
  for (let qi = 0; qi < QUAD_SEQ.length; qi++) {
    let lo = null;
    let hi = null;
    for (let i = 0; i <= steps; i++) {
      const rel = (i / steps) * 90;
      const t = ((QUAD_BASE[qi] + rel + 90) * Math.PI) / 180;
      const dx = Math.cos(t);
      const dy = Math.sin(t);
      const inPage = rayInterval(cx, cy, dx, dy, page);
      if (!inPage) continue;
      const inRect = rayInterval(cx, cy, dx, dy, rect);
      if (outsideRun(inPage, inRect) < minRun) continue;
      if (lo === null) lo = rel;
      hi = rel;
    }
    spans[QUAD_SEQ[qi]] = lo === null ? [0, 90] : [lo, hi];
  }
  return spans;
}

/** 从极点沿 theta 走出死区、且仍在页面内的第一个可取点 */
function pointOutsideRect(rect, page, theta, margin = 2) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  const limit = Math.hypot(page.width, page.height);
  const insidePage = (x, y) =>
    x >= page.left && x <= page.left + page.width && y >= page.top && y <= page.top + page.height;
  for (let s = 1; s <= limit; s += 1) {
    if (!insidePage(cx + dx * s, cy + dy * s)) return null;
    const t = s + margin;
    const x = cx + dx * t;
    const y = cy + dy * t;
    if (!insidePage(x, y)) return null;
    if (!insideRect(x, y, rect)) return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

function expectedFrame(x, y, rect, spans, frameCount) {
  if (insideRect(x, y, rect)) return 0;
  const phi = phiOf(x, y, rect);
  const base = Math.floor(phi / 90) * 90;
  const rel = phi - base;
  const [lo, hi] = spans[QUAD_SEQ[base / 90]];
  const u = hi - lo > 1e-9 ? Math.min(1, Math.max(0, (rel - lo) / (hi - lo))) : rel / 90;
  return ((base + u * 90) / 360) * (frameCount - 1);
}

/** 象限归属：phi ∈ (0,90) 左下 / (90,180) 左上 / (180,270) 右上 / (270,360) 右下 */
function quadrantOf(x, y, rect) {
  if (insideRect(x, y, rect)) return 'inside';
  const p = phiOf(x, y, rect);
  if (p < 90) return 'BL';
  if (p < 180) return 'TL';
  if (p < 270) return 'TR';
  return 'BR';
}

/* ── 静态服务 ─────────────────────────────────────────────────────────── */
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

/* ── Chrome + CDP ─────────────────────────────────────────────────────── */
async function startChrome() {
  mkdirSync(join(CHROME_TMP, 'crash'), { recursive: true });
  // Chrome 的抱怨都走 stderr。丢进日志文件，起不来时把尾部带进报错——
  // "环境不可用" 却不给原因，是最难查的一种失败。
  const logPath = join(TMP, 'chrome.log');
  const logFd = openSync(logPath, 'w');
  const proc = spawn(
    CHROME,
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
    // HOME 也指到同一个短目录：否则 Chrome 会去 mkdir /root 并写
    // ~/.local/share/applications/mimeapps.list，权限不足刷一屏噪音
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
  throw new Error(
    `Chrome 调试端口 ${CDP_PORT} 未就绪（exitCode=${proc.exitCode}，日志 ${logPath}）\n${tail}`
  );
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
    throw new Error(
      `页面内求值抛错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
    );
  }
  return r.result.value;
};

const hash = (buf) => {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) h = ((h ^ buf[i]) * 16777619) >>> 0;
  return h.toString(16);
};

/* 背景图百分比 → 帧序号。雪碧图按行折返，绝不能用 X 百分比判单调/跟随。 */
const indexFromBgPos = (bg, columns, rows) => {
  const [xp, yp] = bg.split(/\s+/).map(Number.parseFloat);
  if (!Number.isFinite(xp) || !Number.isFinite(yp)) return null;
  const col = Math.round((xp / 100) * (columns - 1));
  const row = Math.round((yp / 100) * (rows - 1));
  return row * columns + col;
};

const movePointer = (send, x, y) =>
  send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    buttons: 0,
    button: 'none',
    clickCount: 0,
  });

const readBgPos = (send) =>
  evaluate(send, `getComputedStyle(document.querySelector('[data-sprite]')).backgroundPosition`);

/** 派发指针后轮询到帧序号连续 STABLE_HITS 次不变，返回该帧与耗时 */
const settle = async (send, columns, rows) => {
  const t0 = Date.now();
  let prev = null;
  let hits = 0;
  let frame = null;
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    frame = indexFromBgPos(await readBgPos(send), columns, rows);
    if (frame !== null && frame === prev) hits++;
    else hits = 0;
    prev = frame;
    if (hits >= STABLE_HITS - 1) return { frame, ms: Date.now() - t0, timeout: false };
    await sleep(STABLE_POLL_MS);
  }
  return { frame, ms: Date.now() - t0, timeout: true };
};

/** 一次派发后同时等**多个舞台**的切图读数稳定；返回与 ids 同序的帧序号数组。
    对比区两栏同受一次 pointermove 驱动，但各有各的极点与进度，
    所以必须一次读完再判稳定，不能一栏一栏地等。 */
const settleStages = async (send, ids, grids) => {
  const t0 = Date.now();
  let prev = null;
  let hits = 0;
  let frames = null;
  const read = () =>
    evaluate(
      send,
      `(() => {
         const vs = document.querySelectorAll('[data-sprite-view]');
         const ids = ${JSON.stringify(ids)};
         return ids.map((i) => {
           const el = vs[i] && vs[i].querySelector('[data-sprite]');
           return el ? getComputedStyle(el).backgroundPosition : '';
         });
       })()`
    );
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    const bg = await read();
    frames = bg.map((b, k) => indexFromBgPos(b, grids[k][0], grids[k][1]));
    const key = JSON.stringify(frames);
    if (key === prev) hits++;
    else hits = 0;
    prev = key;
    if (hits >= STABLE_HITS - 1) return { frames, ms: Date.now() - t0, timeout: false };
    await sleep(STABLE_POLL_MS);
  }
  return { frames, ms: Date.now() - t0, timeout: true };
};

/* ── 主流程 ───────────────────────────────────────────────────────────── */
let server;
let chrome;
let ws;
let failed = 0;
const failures = [];
const warnings = [];

try {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先 npm run build');
  await mkdir(TMP, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const url = `http://127.0.0.1:${HTTP_PORT}/index.html${NAV_Q}`;
  server = await startServer();
  chrome = await startChrome();
  const cdp = await connectCdp();
  ws = cdp.ws;
  const { send } = cdp;

  const exceptions = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push(d.exception?.description ?? d.text);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(1800);
  await evaluate(send, 'window.scrollTo(0,0); document.fonts.ready');

  const geom = await evaluate(
    send,
    `(() => {
       const view = document.querySelector('[data-sprite-view]');
       const el = view && view.querySelector('[data-sprite]');
       if (!el) return null;
       const r = el.getBoundingClientRect();
       const s = view.getBoundingClientRect();
       return {
         left: r.left, top: r.top, width: r.width, height: r.height,
         stage: { left: s.left, top: s.top, width: s.width, height: s.height },
         columns: Number(view.dataset.columns), rows: Number(view.dataset.rows),
         frameCount: Number(view.dataset.frameCount),
         personInset: view.dataset.personInset ?? '',
         hasReadout: !!document.querySelector('[data-frame]'),
         cards: document.querySelectorAll('[data-depth]').length,
       };
     })()`
  );
  if (!geom) throw new Error('页面里找不到 [data-sprite-view] / [data-sprite] —— 舞台没渲染');
  const { columns, rows, frameCount } = geom;
  if (!Number.isFinite(frameCount) || !Number.isFinite(columns) || !Number.isFinite(rows)) {
    throw new Error('读不到 data-frame-count / data-columns / data-rows');
  }

  const { width: W, height: H } = VIEWPORT;
  /* 立绘元素盒 → 人物图片区域矩形（按 data-person-inset 内缩） */
  const elemBox = { left: geom.left, top: geom.top, width: geom.width, height: geom.height };
  const insetsRaw = String(geom.personInset).trim();
  const insets = insetsRaw.split(/\s+/).map(Number);
  const validInset =
    insetsRaw !== '' &&
    insets.length === 4 &&
    insets.every((v) => Number.isFinite(v) && v >= 0 && v < 1);
  if (insetsRaw !== '' && !validInset) {
    warnings.push(`data-person-inset 非法（"${insetsRaw}"），期望值按 0 内缩计算`);
  }
  const inset = validInset ? insets : [0, 0, 0, 0];
  const rect = {
    left: elemBox.left + elemBox.width * inset[0],
    top: elemBox.top + elemBox.height * inset[1],
    width: elemBox.width * (1 - inset[0] - inset[2]),
    height: elemBox.height * (1 - inset[1] - inset[3]),
  };
  const page = { left: 0, top: 0, width: W, height: H };
  const spans = reachableSpans(rect, page);
  const padX = Math.max(20, Math.min(PAD, rect.left - 2, W - (rect.left + rect.width) - 2));
  const padY = Math.max(20, Math.min(PAD, rect.top - 2));

  const probes = [
    ['rect-center', (rect.left + rect.width / 2), (rect.top + rect.height / 2), 'inside'],
    ['rect-inner', (rect.left + rect.width * 0.75), (rect.top + rect.height * 0.75), 'inside'],
    // 视口四角 —— 用户报障用的就是这四个坐标
    ['corner-TL', 1, 1, 'quadrant'],
    ['corner-TR', W - 2, 1, 'quadrant'],
    ['corner-BL', 1, H - 2, 'quadrant'],
    ['corner-BR', W - 2, H - 2, 'quadrant'],
    // 贴着人物矩形四角外推 —— 落在各象限的角平分线附近，离象限边界最远
    ['edge-TL', rect.left - padX, Math.max(1, rect.top - padY), 'quadrant'],
    ['edge-TR', rect.left + rect.width + padX, Math.max(1, rect.top - padY), 'quadrant'],
    ['edge-BL', rect.left - padX, H - 2, 'quadrant'],
    ['edge-BR', rect.left + rect.width + padX, H - 2, 'quadrant'],
  ];

  const clip = {
    x: Math.max(0, Math.floor(rect.left)),
    y: Math.max(0, Math.floor(rect.top)),
    width: Math.min(Math.ceil(rect.width), W - Math.floor(rect.left)),
    height: Math.min(Math.ceil(rect.height), H - Math.floor(rect.top)),
    scale: 1,
  };

  const shoot = async (name) => {
    const full = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(OUT, `follow-${name}.png`), Buffer.from(full.data, 'base64'));
  };

  const results = [];
  for (const [name, fx, fy, kind] of probes) {
    const x = Math.round(Math.max(0, Math.min(W - 1, fx)));
    const y = Math.round(Math.max(0, Math.min(H - 1, fy)));
    const quadrant = quadrantOf(x, y, rect);
    if (kind === 'quadrant' && quadrant === 'inside') {
      warnings.push(`${name} (${x},${y}) 落在人物矩形内，无法用于象限断言，已跳过`);
      continue;
    }
    await movePointer(send, x, y);
    const settled = await settle(send, columns, rows);
    const read = await evaluate(
      send,
      `(() => {
         const label = document.querySelector('[data-frame]');
         return { bgPos: getComputedStyle(document.querySelector('[data-sprite]')).backgroundPosition,
                  readout: label ? Number(label.textContent) : null };
       })()`
    );
    const shot = await send('Page.captureScreenshot', { format: 'png', clip });
    if (name.startsWith('edge-') || name.startsWith('corner-')) await shoot(name);
    results.push({
      name,
      kind,
      x,
      y,
      quadrant,
      expected: expectedFrame(x, y, rect, spans, frameCount),
      frame: settled.frame,
      settleMs: settled.ms,
      settled: !settled.timeout,
      readout: read.readout,
      bgPos: read.bgPos,
      pxHash: hash(Buffer.from(shot.data, 'base64')),
    });
  }

  /* 确定性复采样：先去人物中心，再回到第一个象限探针，读数应复原 */
  const first = results.find((r) => r.kind === 'quadrant');
  await movePointer(send, Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
  await settle(send, columns, rows);
  await movePointer(send, first.x, first.y);
  const repeatRead = await settle(send, columns, rows);
  const repeat = repeatRead.frame;

  /* ── 断言 ──────────────────────────────────────────────────────────── */
  const check = (ok, msg) => {
    if (!ok) {
      failed++;
      failures.push(msg);
    }
  };

  const band = frameCount / 4;
  const ORDER = { BL: 0, TL: 1, TR: 2, BR: 3 };

  /* ── 段端点覆盖率：每个象限都必须能取到本段的首帧与尾帧 ────────────────
     这是"只按 phi/360 线性映射"唯一的照妖镜。象限带断言只看区间是否越界，
     端点取不到时区间断言照样通过（段内的那些帧仍在带内），所以必须直接查端点。 */
  const coverage = [];
  for (let qi = 0; qi < QUAD_SEQ.length; qi++) {
    const q = QUAD_SEQ[qi];
    const base = QUAD_BASE[qi];
    /* 端点方向本身就是象限边界（rel=0 与 rel=90 各是一条半轴，也就是接缝），
       正好落在边界上时象限归属是零测度的，所以往段内缩 0.5° 再探。 */
    for (const [tag, rel, want] of [
      ['start', spans[q][0] + 0.5, (base / 360) * (frameCount - 1)],
      ['end', spans[q][1] - 0.5, ((base + 90) / 360) * (frameCount - 1)],
    ]) {
      const theta = ((base + rel + 90) * Math.PI) / 180;
      const p = pointOutsideRect(rect, page, theta);
      const row = { quadrant: q, tag, rel: Number(rel.toFixed(2)), want: Number(want.toFixed(1)), x: null, y: null, frame: null };
      if (!p) {
        warnings.push(`${q}-${tag}（rel=${rel.toFixed(2)}°）方向上找不到死区外且页内的点，已跳过`);
        coverage.push(row);
        continue;
      }
      row.x = p.x;
      row.y = p.y;
      await movePointer(send, p.x, p.y);
      const s = await settle(send, columns, rows);
      row.frame = s.frame;
      row.settleMs = s.ms;
      coverage.push(row);
      check(
        s.frame !== null && Math.abs(s.frame - want) <= 2,
        `${q} 象限的${tag === 'start' ? '首' : '尾'}帧取不到：该方向应给出第 ${want.toFixed(1)} 帧，` +
          `实测 ${s.frame}（本象限可达角度 ${spans[q][0].toFixed(1)}–${spans[q][1].toFixed(1)}°，` +
          `端点帧未被铺满）`
      );
    }
  }

  for (const r of results) {
    if (r.frame === null) {
      check(false, `${r.name} 读不到帧序号（background-position=${r.bgPos}）`);
      continue;
    }
    check(
      r.settled,
      `${r.name} 帧序号在 ${SETTLE_TIMEOUT_MS}ms 内未收敛（最后读到 ${r.frame}）`
    );
    if (r.kind === 'inside') {
      check(r.frame === 0, `${r.name} 在人物矩形内应停在第 0 帧，实测 ${r.frame}`);
      continue;
    }
    const lo = ORDER[r.quadrant] * band;
    const hi = lo + band;
    check(
      r.frame >= Math.floor(lo - 0.5) && r.frame <= Math.ceil(hi + 0.5),
      `${r.name} 落在【${r.quadrant}】象限，帧应落在 [${(lo - 0.5).toFixed(1)}, ${(hi + 0.5).toFixed(1)}]，实测 ${r.frame}`
    );
    check(
      Math.abs(r.frame - Math.round(r.expected)) <= 2,
      `${r.name}（${r.quadrant}）帧与契约期望 ${r.expected.toFixed(1)} 偏差超过 ±2，实测 ${r.frame}`
    );
    if (r.readout !== null) {
      check(
        r.readout === r.frame,
        `${r.name} 读数 DOM(${r.readout}) 与实际切图帧(${r.frame}) 不一致`
      );
    }
  }

  /* 跨象限必须真的换帧：不同象限渲染出同一张图 = 人物没动 */
  const quadProbes = results.filter((r) => r.kind === 'quadrant');
  const seen = new Map();
  for (const r of quadProbes) {
    const prev = seen.get(r.pxHash);
    if (prev && ORDER[prev.quadrant] !== ORDER[r.quadrant]) {
      check(
        false,
        `${prev.name} 与 ${r.name} 分属【${prev.quadrant}】/【${r.quadrant}】但渲染像素完全相同 → 人物没有跟随`
      );
    }
    seen.set(r.pxHash, r);
  }

  /* 四象限帧序必须严格递增 —— 需求里"左下→左上→右上→右下"的顺序约束 */
  const byQuad = {};
  for (const r of quadProbes) (byQuad[r.quadrant] ??= []).push(r.frame);
  const means = Object.fromEntries(
    Object.entries(byQuad).map(([q, arr]) => [q, arr.reduce((a, b) => a + b, 0) / arr.length])
  );
  const seq = ['BL', 'TL', 'TR', 'BR'];
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    if (means[a] === undefined || means[b] === undefined) continue;
    check(
      means[a] < means[b],
      `帧序不符：${a} 的均值 ${means[a].toFixed(1)} 未小于 ${b} 的均值 ${means[b].toFixed(1)}`
    );
  }

  check(
    repeat === first.frame,
    `确定性失败：${first.name} 复采样得到 ${repeat}，首次为 ${first.frame}`
  );
  check(exceptions.length === 0, `页面抛异常：${exceptions.join(' | ')}`);

  /* ── 卡片视差**计算路径**回归（与帧随动共用一次 pointermove）─────────────
     这里验证的是「x/y 仍然是相对舞台归一化的」。改成人物矩形归一化会让视差
     在人物两侧极短的行程内打满，而帧随动的断言看不出这个退化。
     注意：本项目桌面版 `hero.css` 已不再把 `--px/--py` 接进 transform
     （视差在视觉上停用，脚本路径刻意保留），所以这条只断言**计算**，
     不断言卡片真的动了。 */
  let parallax = null;
  if (geom.cards > 0) {
    const stage = geom.stage;
    const sx = stage.left + stage.width / 2;
    const sy = stage.top + stage.height / 2;
    const readCard = () =>
      evaluate(
        send,
        `(() => {
           const c = document.querySelector('[data-depth]');
           const s = getComputedStyle(c);
           return { px: Number.parseFloat(s.getPropertyValue('--px')) || 0,
                    py: Number.parseFloat(s.getPropertyValue('--py')) || 0 };
         })()`
      );
    const at = async (x, y) => {
      await movePointer(send, Math.round(x), Math.round(y));
      await settle(send, columns, rows);
      return readCard();
    };
    const center = await at(sx, sy);
    const left = await at(stage.left + stage.width * 0.1, sy);
    const right = await at(stage.left + stage.width * 0.9, sy);
    const top = await at(sx, stage.top + stage.height * 0.1);
    const bottom = await at(sx, stage.top + stage.height * 0.9);
    parallax = { cards: geom.cards, center, left, right, top, bottom };

    check(
      Math.abs(center.px) <= 1.5 && Math.abs(center.py) <= 1.5,
      `视差未归中：舞台中心处 --px=${center.px} --py=${center.py}（应≈0）`
    );
    check(
      left.px < -5 && right.px > 5,
      `视差横向未跟随：左侧 --px=${left.px}（应<−5）、右侧 --px=${right.px}（应>5）`
    );
    check(
      top.py < -2 && bottom.py > 2,
      `视差纵向未跟随：上侧 --py=${top.py}（应<−2）、下侧 --py=${bottom.py}（应>2）`
    );
  }

  /* ── A/B 对比区：两栏各自以**自身**人物矩形为极点 ──────────────────────
     对比区是页面上除 hero 之外的第二、第三个 [data-sprite-view]。
     契约完全相同，几何必须各自独立——用同一个极点的话，靠边那一栏
     会算出错误角度。这里独立验三件事：

       A) 每栏都满足契约（探针实测帧 vs 独立实现的期望值，偏差 ≤ ±2）
          —— 同时把「几何按舞台分开」这条实现约束守住。
       B) **素材本身**在左下段的可见变化量：B 必须显著大于 A。
          这条测的不是映射而是素材，正是 B 方案存在的理由；哪天 B 被换回
          线性手势序列，它会立刻变红。
       C) B 的首尾接缝闭合（frame 45 ≡ frame 0），A 不闭合。

     素材级测量在页面内做：把图集按格画进 64×80 画布再取像素。
     node 侧没有 WebP 解码器，这是最省事的可靠路径。 */
  let compare = null;
  const stageCount = await evaluate(send, `document.querySelectorAll('[data-sprite-view]').length`);
  if (stageCount < 3) {
    warnings.push(`页面只有 ${stageCount} 个舞台，跳过 A/B 对比区断言`);
  } else {
    const atlasMad = (asset, cols, cellW, cellH, pairs) =>
      evaluate(
        send,
        `(async () => {
           const img = new Image();
           img.src = ${JSON.stringify(asset)};
           await img.decode();
           const cv = document.createElement('canvas');
           cv.width = 64; cv.height = 80;
           const ctx = cv.getContext('2d', { willReadFrequently: true });
           const grab = (f) => {
             const col = f % ${cols}, row = Math.floor(f / ${cols});
             ctx.clearRect(0, 0, 64, 80);
             ctx.drawImage(img, col * ${cellW}, row * ${cellH}, ${cellW}, ${cellH}, 0, 0, 64, 80);
             return ctx.getImageData(0, 0, 64, 80).data;
           };
           const mad = (u, v) => {
             let s = 0, n = 0;
             for (let i = 0; i < u.length; i += 4) {
               if (u[i + 3] < 16 && v[i + 3] < 16) continue;
               s += (Math.abs(u[i] - v[i]) + Math.abs(u[i + 1] - v[i + 1]) + Math.abs(u[i + 2] - v[i + 2])) / 3;
               n++;
             }
             return n ? s / n : 0;
           };
           const cache = {};
           const at = (f) => (cache[f] ?? (cache[f] = grab(f)));
           return ${JSON.stringify(pairs)}.map(([a, b, tag]) => ({ tag, a, b, mad: mad(at(a), at(b)) }));
         })()`
      );

    /* 先滚到对比区：探针坐标是视口坐标，元件必须在视口里；
       滚动会触发驱动层的 measure()，人物矩形随之更新。 */
    await evaluate(
      send,
      `(() => { const s = document.querySelector('.cmp'); if (s) s.scrollIntoView({ block: 'center' }); })()`
    );
    await sleep(260);

    const stages = await evaluate(
      send,
      `(() => {
         const out = [];
         document.querySelectorAll('[data-sprite-view]').forEach((v, i) => {
           const el = v.querySelector('[data-sprite]');
           if (!el) return;
           const r = el.getBoundingClientRect();
           const raw = String(v.dataset.personInset || '').trim();
           const ins = raw.split(/\\s+/).map(Number);
           const ok = ins.length === 4 && ins.every((n) => Number.isFinite(n) && n >= 0 && n < 1);
           const panel = v.closest('.cmp__panel');
           out.push({
             i,
             label: panel ? panel.querySelector('.cmp__name').textContent : 'hero',
             asset: v.dataset.asset,
             left: r.left, top: r.top, width: r.width, height: r.height,
             columns: Number(v.dataset.columns), rows: Number(v.dataset.rows),
             frameCount: Number(v.dataset.frameCount),
             inset: ok ? ins : [0, 0, 0, 0],
           });
         });
         return out;
       })()`
    );

    const cmpStages = stages.filter((s) => s.i > 0);
    const probes = [];
    for (const s of cmpStages) {
      const r = {
        left: s.left + s.width * s.inset[0],
        top: s.top + s.height * s.inset[1],
        width: s.width * (1 - s.inset[0] - s.inset[2]),
        height: s.height * (1 - s.inset[1] - s.inset[3]),
      };
      s.rect = r;
      s.spans = reachableSpans(r, page);
      const pad = 44;
      probes.push({ stage: s, name: `${s.label}·左下`, x: r.left - pad, y: r.top + r.height + pad });
      probes.push({ stage: s, name: `${s.label}·右上`, x: r.left + r.width + pad, y: r.top - pad });
    }

    const ids = cmpStages.map((s) => s.i);
    const grids = cmpStages.map((s) => [s.columns, s.rows]);
    const rowsOut = [];
    for (const p of probes) {
      const x = Math.round(Math.max(0, Math.min(W - 1, p.x)));
      const y = Math.round(Math.max(0, Math.min(H - 1, p.y)));
      await movePointer(send, x, y);
      const settled = await settleStages(send, ids, grids);
      const frame = settled.frames?.[ids.indexOf(p.stage.i)] ?? null;
      const want = Math.round(
        expectedFrame(x, y, p.stage.rect, p.stage.spans, p.stage.frameCount)
      );
      const q = quadrantOf(x, y, p.stage.rect);
      rowsOut.push({ ...p, name: p.name, x, y, quadrant: q, want, frame, settleMs: settled.ms, settled: !settled.timeout });
      check(settled.timeout === false, `${p.name} 帧序号未在 ${SETTLE_TIMEOUT_MS}ms 内收敛`);
      check(
        frame !== null && Math.abs(frame - want) <= 2,
        `${p.name}（${p.stage.label}·${q}）应 ≈ ${want} 帧，实测 ${frame} —— 每栏必须以自身人物矩形为极点`
      );
    }

    const madOf = (s) =>
      atlasMad(s.asset, s.columns, 482, 602, [
        [0, 5, '左下·前段'],
        [5, 11, '左下·后段'],
        [45, 0, '首尾接缝'],
      ]);
    const madA = await madOf(cmpStages[0]);
    const madB = await madOf(cmpStages[1]);
    const sum = (rows, tag) => rows.filter((r) => r.tag !== '首尾接缝').reduce((a, r) => a + r.mad, 0);
    const seam = (rows) => rows.find((r) => r.tag === '首尾接缝').mad;

    check(
      sum(madB) > sum(madA) * 1.8,
      `左下段（帧 0–11）素材可见变化量：B=${sum(madB).toFixed(2)} 未显著大于 A=${sum(madA).toFixed(2)}（需 >1.8×）`
    );
    check(
      seam(madB) < 6,
      `B 方案首尾未闭合：MAD(frame45, frame0)=${seam(madB).toFixed(2)}（应 <6，即同一姿态）`
    );

    compare = {
      stages: stages.map((s) => ({
        i: s.i, label: s.label, asset: s.asset,
        columns: s.columns, rows: s.rows, frameCount: s.frameCount, inset: s.inset,
      })),
      probes: rowsOut.map((r) => ({
        name: r.name, quadrant: r.quadrant, x: r.x, y: r.y,
        want: r.want, frame: r.frame, settleMs: r.settleMs,
      })),
      material: { a: madA, b: madB, ratio: sum(madB) / Math.max(1e-6, sum(madA)) },
    };
  }

  const report = {
    url,
    viewport: VIEWPORT,
    elementBox: elemBox,
    personRect: rect,
    personInset: inset,
    spans,
    grid: { columns, rows, frameCount },
    settle: { pollMs: STABLE_POLL_MS, stableHits: STABLE_HITS, maxMs: SETTLE_TIMEOUT_MS },
    results,
    coverage,
    quadrantMeans: means,
    parallax,
    repeatCheck: { probe: first.name, first: first.frame, repeat },
    compare,
    warnings,
    exceptions,
    failures,
    pass: failed === 0,
  };
  await writeFile(join(OUT, 'follow-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(OUT, 'follow-report.txt'), renderTable(report));

  console.log(renderTable(report));
  if (warnings.length) {
    console.log('\n提示：');
    warnings.forEach((w) => console.log(`  · ${w}`));
  }
  if (failed) {
    console.log(`\n✗ ${failed} 项断言失败：`);
    failures.forEach((f) => console.log(`  · ${f}`));
    process.exitCode = 1;
  } else {
    console.log('\n✓ 全部断言通过');
  }
} catch (e) {
  console.error(`环境不可用：${e.message}`);
  process.exitCode = 2;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome?.kill('SIGKILL');
  if (server) await new Promise((r) => server.close(r));
}

function renderCompare(cmp) {
  if (!cmp) return ['A/B 对比区：页面上没有第二个 [data-sprite-view]，未检查'];
  const out = ['A/B 对比区（每栏以自身人物矩形为极点）'];
  for (const p of cmp.probes) {
    out.push(`  ${p.name}  ${p.quadrant}  期望 ${p.want}  实测 ${p.frame}  收敛 ${p.settleMs}ms`);
  }
  const m = cmp.material;
  const seg = (rows) => rows.filter((r) => r.tag !== '首尾接缝');
  const fm = (rows) => rows.map((r) => `${r.tag} ${r.mad.toFixed(2)}`).join(' / ');
  out.push(`  左下段素材变化量（帧 0–11，MAD）A：${fm(seg(m.a))}`);
  out.push(`                                  B：${fm(seg(m.b))}   → B/A = ${m.ratio.toFixed(1)}×`);
  out.push(
    `  首尾接缝 MAD(frame45,frame0)：A ${m.a.find((r) => r.tag === '首尾接缝').mad.toFixed(2)}` +
      ` / B ${m.b.find((r) => r.tag === '首尾接缝').mad.toFixed(2)}（B 应 ≈0，即闭环）`
  );
  return out;
}

function renderTable(report) {
  const rows = [
    ['探针', '象限', '坐标', '期望', '实测', '收敛ms', 'bgPosition', '像素哈希'],
    ...report.results.map((r) => [
      r.name,
      r.quadrant,
      `${r.x},${r.y}`,
      r.kind === 'inside' ? '0' : r.expected.toFixed(1),
      String(r.frame),
      String(r.settleMs ?? '-'),
      r.bgPos ?? '-',
      r.pxHash,
    ]),
  ];
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
  const coverageRows = [
    ['象限', '端点', '可达rel', '期望帧', '实测帧', '坐标'],
    ...(report.coverage ?? []).map((c) => [
      c.quadrant,
      c.tag === 'start' ? '首帧' : '尾帧',
      `${c.rel}°`,
      c.want.toFixed(1),
      String(c.frame),
      c.x === null ? '-' : `${c.x},${c.y}`,
    ]),
  ];
  const cw = coverageRows[0].map((_, i) =>
    Math.max(...coverageRows.map((r) => String(r[i]).length))
  );
  const cline = (r) => r.map((c, i) => String(c).padEnd(cw[i])).join('  ');
  const means = Object.entries(report.quadrantMeans ?? {})
    .map(([q, v]) => `${q}=${v.toFixed(1)}`)
    .join('  ');
  const spanStr = Object.entries(report.spans ?? {})
    .map(([q, s]) => `${q} ${s[0].toFixed(1)}–${s[1].toFixed(1)}°`)
    .join('  ');
  return [
    `帧随动验收  frameCount=${report.grid.frameCount}  视口 ${report.viewport.width}×${report.viewport.height}`,
    `立绘元素盒 ${report.elementBox.width.toFixed(0)}×${report.elementBox.height.toFixed(0)} @ (${report.elementBox.left.toFixed(0)},${report.elementBox.top.toFixed(0)})`,
    `人物图片区域矩形 ${report.personRect.left.toFixed(1)},${report.personRect.top.toFixed(1)} ${report.personRect.width.toFixed(1)}×${report.personRect.height.toFixed(1)}（内缩 ${report.personInset.map((v) => v.toFixed(4)).join(' ')}）`,
    `象限可达角度  ${spanStr}`,
    `象限帧均值  ${means}`,
    '',
    line(rows[0]),
    w.map((n) => '─'.repeat(n)).join('  '),
    ...rows.slice(1).map(line),
    '',
    '段端点覆盖（每象限首帧/尾帧都必须取得到）',
    cline(coverageRows[0]),
    cw.map((n) => '─'.repeat(n)).join('  '),
    ...coverageRows.slice(1).map(cline),
    '',
    ...renderCompare(report.compare),
    '',
    `确定性复采样：${report.repeatCheck.probe} 首次=${report.repeatCheck.first} 复采样=${report.repeatCheck.repeat}`,
    report.parallax
      ? `卡片视差（${report.parallax.cards} 张，仅计算路径）：中心 --px=${report.parallax.center.px} --py=${report.parallax.center.py}` +
        ` / 左 ${report.parallax.left.px} → 右 ${report.parallax.right.px}` +
        ` / 上 ${report.parallax.top.py} → 下 ${report.parallax.bottom.py}`
      : '卡片视差：页面无 [data-depth]，未检查',
    `页面异常：${report.exceptions.length}`,
    `结论：${report.pass ? 'PASS' : `FAIL（${report.failures.length} 项）`}`,
  ].join('\n');
}
