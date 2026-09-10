/* 帧随动扫描器（诊断工具，不是断言测试）
 *
 * 用途：把整张页面按规则网格铺满探针，逐点派发真实指针事件，读出**实际帧序号**，
 * 打印成与页面同构的文本网格，并把每点的「象限归属 / phi / 契约期望帧」一并列出。
 * 用来回答"某个区域的映射是不是错了"，而不是"契约是否被满足"——后者归
 * qa/verify-sprite-follow.mjs。改映射逻辑时先跑这个看形态，再跑那个验回归。
 *
 * 用法（项目根目录）：
 *   node qa/sweep-follow.mjs                 # 默认 1440x900，12x9 网格
 *   node qa/sweep-follow.mjs --w=1920 --h=1080 --cols=16 --rows=10
 *   node qa/sweep-follow.mjs --region=BL      # 只在人物矩形的左下象限加密扫描
 *   node qa/sweep-follow.mjs --sheet          # 另存「成片表」：逐点裁出人物拼成一张图
 *
 * --sheet 产出 qa/out/sweep-sheet.png：行=页面自上而下、列=自左而右，与页面同构。
 * 这是"映射看着不对"这类报障最快的定位工具——象限错位、段序颠倒会直接看出来。
 *
 * 退出码：0 = 跑完（不判断对错）；2 = 环境不可用
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

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
    .map((base) => join(base, 'cdp-sweep'))
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
const COLS = Number(argv.cols ?? 12);
const ROWS = Number(argv.rows ?? 9);
const REGION = String(argv.region ?? 'all');
const SHEET = Boolean(argv.sheet);
const STABLE_POLL_MS = 120;
const STABLE_HITS = 3;
const STABLE_TIMEOUT_MS = 4000;
const HTTP_PORT = Number(process.env.HTTP_PORT ?? (8600 + (process.pid % 90)));
const CDP_PORT = Number(process.env.CDP_PORT ?? (9100 + (process.pid % 90)));
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
  '.svg': 'image/svg+xml',
};

/* ── 契约的独立实现（与被测代码无关，只用于对照打印） ─────────────────── */
const phiOf = (x, y, rect) => {
  const deg =
    (Math.atan2(y - (rect.top + rect.height / 2), x - (rect.left + rect.width / 2)) * 180) /
    Math.PI;
  return (((deg - 90) % 360) + 360) % 360;
};
const insideRect = (x, y, rect) =>
  x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
const quadrantOf = (x, y, rect) => {
  if (insideRect(x, y, rect)) return 'IN';
  const p = phiOf(x, y, rect);
  return p < 90 ? 'BL' : p < 180 ? 'TL' : p < 270 ? 'TR' : 'BR';
};

const indexFromBgPos = (bg, columns, rows) => {
  const [xp, yp] = bg.split(/\s+/).map(Number.parseFloat);
  if (!Number.isFinite(xp) || !Number.isFinite(yp)) return null;
  const col = Math.round((xp / 100) * (columns - 1));
  const row = Math.round((yp / 100) * (rows - 1));
  return row * columns + col;
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
  const logPath = join(ROOT, '.tmp', 'sweep-chrome.log');
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
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
  throw new Error(`Chrome 调试端口 ${CDP_PORT} 未就绪（exitCode=${proc.exitCode}）\n${tail}`);
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

const main = async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先 npm run build');
  await mkdir(OUT, { recursive: true });

  const server = await startServer();
  let chrome = null;
  let ws = null;
  try {
    chrome = await startChrome();
    const cdp = await connectCdp();
    ws = cdp.ws;
    const { send } = cdp;
    await send('Page.enable');
    await send('Runtime.enable');

    const url = `http://127.0.0.1:${HTTP_PORT}/index.html${NAV_Q}`;
    await send('Page.navigate', { url });
    await sleep(1200);

    const geom = await evaluate(
      send,
      `(() => {
         const view = document.querySelector('[data-sprite-view]');
         const el = document.querySelector('[data-sprite]');
         if (!view || !el) return null;
         const s = view.getBoundingClientRect();
         const f = el.getBoundingClientRect();
         return {
           stage: { left: s.left, top: s.top, width: s.width, height: s.height },
           sprite: { left: f.left, top: f.top, width: f.width, height: f.height },
           columns: Number(view.dataset.columns),
           rows: Number(view.dataset.rows),
           frameCount: Number(view.dataset.frameCount),
           inner: { w: window.innerWidth, h: window.innerHeight },
         };
       })()`
    );
    if (!geom) throw new Error('页面上找不到 [data-sprite-view] / [data-sprite]');

    const { sprite: rect, columns, rows, frameCount } = geom;
    console.log('=== 几何 ===');
    console.log('舞台 :', JSON.stringify(geom.stage));
    console.log('人物 :', JSON.stringify(rect), `中心=(${(rect.left + rect.width / 2).toFixed(1)}, ${(rect.top + rect.height / 2).toFixed(1)})`);
    console.log('视口 :', JSON.stringify(geom.inner), `网格 ${COLS}x${ROWS}  区域=${REGION}`);

    const readFrame = async () => {
      let last = null;
      let hits = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < STABLE_TIMEOUT_MS) {
        const bg = await evaluate(
          send,
          `getComputedStyle(document.querySelector('[data-sprite]')).backgroundPosition`
        );
        const idx = indexFromBgPos(bg, columns, rows);
        if (idx !== null && idx === last) {
          if (++hits >= STABLE_HITS) return { idx, bg, settled: true };
        } else {
          hits = 0;
        }
        last = idx;
        await sleep(STABLE_POLL_MS);
      }
      return { idx: last, bg: null, settled: false };
    };

    const W = geom.inner.w;
    const H = geom.inner.h;
    /* 网格取「单元格中心」：边界上 phi 会跳变，取中心才代表该区域 */
    const xs = [];
    const ys = [];
    if (REGION === 'BL') {
      for (let i = 1; i <= COLS; i++) xs.push((i / COLS) * (rect.left + rect.width / 2));
      for (let j = 1; j <= ROWS; j++) ys.push(rect.top + rect.height / 2 + (j / ROWS) * (H - (rect.top + rect.height / 2)));
    } else {
      for (let i = 0; i < COLS; i++) xs.push(((i + 0.5) / COLS) * W);
      for (let j = 0; j < ROWS; j++) ys.push(((j + 0.5) / ROWS) * H);
    }

    const cells = [];
    let unsettled = 0;
    /* 逐次运行写进与网格尺寸绑定的目录：同尺寸覆盖同名文件、异尺寸各占一目录，
       于是永远不需要"先删旧的再写新的"（本机 rm 有护栏，删除是麻烦事）。 */
    const tileDir = join(ROOT, '.tmp', `sweep-tiles-${COLS}x${ROWS}`);
    if (SHEET) await mkdir(tileDir, { recursive: true });
    /* 裁人物矩形外扩一点，让"人有没有变"在成片表里一眼可辨。
       四边各自 clamp 后再算宽高：tile 滤镜要求每格等尺寸，混算会报错。 */
    const MARGIN = 24;
    const cx0 = Math.max(0, rect.left - MARGIN);
    const cy0 = Math.max(0, rect.top - MARGIN);
    const cx1 = Math.min(W, rect.left + rect.width + MARGIN);
    const cy1 = Math.min(H, rect.top + rect.height + MARGIN);
    const clip = { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0, scale: 0.45 };

    for (let j = 0; j < ys.length; j++) {
      const rowCells = [];
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        const y = ys[j];
        const px = Math.round(Math.min(W - 1, Math.max(0, x)));
        const py = Math.round(Math.min(H - 1, Math.max(0, y)));
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: px,
          y: py,
          buttons: 0,
          button: 'none',
          clickCount: 0,
        });
        const r = await readFrame();
        if (!r.settled) unsettled++;
        if (SHEET) {
          const shot = await send('Page.captureScreenshot', { format: 'png', clip });
          await writeFile(
            join(tileDir, `tile_r${String(j).padStart(2, '0')}c${String(i).padStart(2, '0')}.png`),
            Buffer.from(shot.data, 'base64')
          );
        }
        const q = quadrantOf(px, py, rect);
        const expected = insideRect(px, py, rect)
          ? 0
          : (phiOf(px, py, rect) / 360) * (frameCount - 1);
        rowCells.push({
          x: px,
          y: py,
          q,
          phi: Number(phiOf(px, py, rect).toFixed(1)),
          expected: Number(expected.toFixed(1)),
          frame: r.idx,
          delta: r.idx === null ? null : Number((r.idx - expected).toFixed(1)),
        });
      }
      cells.push(rowCells);
    }

    /* ── 打印：帧序号网格（同构于页面布局） ─────────────────────────── */
    const pad = (s, n) => String(s).padStart(n);
    console.log('\n=== 实际帧序号（行=自上而下，列=自左而右） ===');
    console.log(`        ${xs.map((x) => pad('x' + Math.round(x), 5)).join('')}`);
    cells.forEach((rowCells, j) => {
      console.log(
        `y${pad(Math.round(ys[j]), 4)} ${rowCells.map((c) => pad(c.frame ?? '?', 5)).join('')}`
      );
    });

    console.log('\n=== 象限归属（IN=人物矩形内） ===');
    cells.forEach((rowCells, j) => {
      console.log(
        `y${pad(Math.round(ys[j]), 4)} ${rowCells.map((c) => pad(c.q, 5)).join('')}`
      );
    });

    console.log('\n=== 契约期望帧 ===');
    cells.forEach((rowCells, j) => {
      console.log(
        `y${pad(Math.round(ys[j]), 4)} ${rowCells.map((c) => pad(c.expected, 5)).join('')}`
      );
    });

    console.log('\n=== 实测 − 期望（|差| ≥ 1.5 才标出） ===');
    cells.forEach((rowCells, j) => {
      console.log(
        `y${pad(Math.round(ys[j]), 4)} ${rowCells
          .map((c) => pad(c.delta !== null && Math.abs(c.delta) >= 1.5 ? c.delta : '·', 5))
          .join('')}`
      );
    });

    /* ── 每个象限的实测帧值域（判断"某段是否被跳过/颠倒"） ──────────── */
    const byQ = {};
    for (const rowCells of cells) {
      for (const c of rowCells) {
        if (c.frame === null) continue;
        (byQ[c.q] ??= []).push({ frame: c.frame, expected: c.expected, x: c.x, y: c.y });
      }
    }
    console.log('\n=== 各象限实测帧范围 ===');
    for (const q of ['IN', 'BL', 'TL', 'TR', 'BR']) {
      const list = byQ[q];
      if (!list?.length) {
        console.log(`${q}: 无探针`);
        continue;
      }
      const fr = list.map((d) => d.frame);
      const ex = list.map((d) => d.expected);
      const maxDelta = Math.max(...list.map((d) => Math.abs(d.frame - d.expected)));
      console.log(
        `${pad(q, 2)}  n=${pad(list.length, 3)}  实测 ${pad(Math.min(...fr), 2)}–${pad(
          Math.max(...fr),
          2
        )}  期望 ${Math.min(...ex).toFixed(1)}–${Math.max(...ex).toFixed(1)}  最大偏差 ${maxDelta.toFixed(1)}`
      );
    }
    console.log(`\n未收敛探针：${unsettled}`);

    if (SHEET) {
      const sheetPath = join(OUT, 'sweep-sheet.png');
      const r = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-pattern_type',
          'glob',
          '-i',
          join(tileDir, 'tile_*.png'),
          '-filter_complex',
          `tile=${COLS}x${ROWS}`,
          '-frames:v',
          '1',
          sheetPath,
        ],
        { encoding: 'utf8', env: { ...process.env, TMPDIR: join(ROOT, '.tmp') } }
      );
      console.log(
        r.status === 0 ? `成片表：${sheetPath}` : `成片表生成失败（ffmpeg exit ${r.status}）：${r.stderr}`
      );
    }

    await writeFile(
      join(OUT, 'sweep-follow.json'),
      JSON.stringify({ geom, cols: xs, rows: ys, cells }, null, 2)
    );
    console.log(`报告：${join(OUT, 'sweep-follow.json')}`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    chrome?.kill('SIGKILL');
    server.close();
  }
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(2);
  }
);
