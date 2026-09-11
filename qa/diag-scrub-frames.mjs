#!/usr/bin/env node
/* 滑动跳帧测量：录制一次真实滚轮拖动过程中的**逐 rAF 帧号时间线**。
 *
 * 目的：区分两种"跳帧"观感来源——
 *   A. 缓动快进（smoothTime 的合法后果）：目标帧拉远，缓动在数帧内冲过，
 *      每渲染帧跨多帧。特征是**单调、无重复、最后收敛停住**。
 *   B. 段解码空窗（按需取段的 bug）：某段还没解码好，中间帧被跳过，
 *      表现为**帧号非单调回退 / 长时间停在同一帧再猛跳**。
 *
 * 量什么（每次 render 回调记一条）：
 *   t（performance.now 相对起点）、frame、Δframe（相对上一条）
 * 另记：段加载事件（若 renderer 暴露）、以及拖动结束后是否收敛。
 *
 * 判据：
 *   - 帧差值始终 ≥ 0（无回退）
 *   - 结束时收敛到目标帧
 *   - 打印每帧停顿时间，暴露"停在同一帧 N 帧"的空窗
 *
 * 用法：node qa/diag-scrub-frames.mjs [W] [H]
 * 前提：先 npm run build（读 dist/）。自带起静态服务 + Chrome。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';

const W = Number(process.argv[2] ?? 1280);
const H = Number(process.argv[3] ?? 800);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'qa/out');
/* ⚠️ Chrome 的 --user-data-dir 必须放**短路径**：其 SingletonSocket 是
 * Unix domain socket，路径上限 108 字节。项目路径一深就必踩
 * `FATAL process_singleton_posix.cc: Socket path too long` → 进程秒退
 * （随后 crashpad 报 ptrace 失败，那是**后果不是原因**）。
 * 本项目路径本身已很长，再拼 .tmp/cdp-xxx 就超限 → 一律放 /home/vii/.tmp。 */
const TMP = '/home/vii/.tmp/iam-daidai-qa';
const HTTP_PORT = 8921;
const CDP_PORT = 9365;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(DIST, p);
      if (!file.startsWith(DIST)) return res.writeHead(403).end();
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

async function cdp(port, path, method = 'GET', body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/* 装探针：劫持 canvas 的 dataset.currentFrame 不可行（renderer 直画不走 dataset），
 * 改为监听 --sc 的变化——它由 scroll-scrub 的 render 回调里 setScatter(frame/192)
 * 写入，与帧号一一对应。用 MutationObserver 抓 :root style 的每次写入，
 * 就能还原"每渲染帧的帧号时间线"，且不需要改源码。 */
const INSTALL = `(() => {
  window.__frames = [];
  window.__t0 = performance.now();
  const root = document.documentElement;
  const read = () => {
    const raw = getComputedStyle(root).getPropertyValue('--sc').trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  let last = null;
  const push = () => {
    const sc = read();
    if (sc == null) return;
    if (sc === last) return;
    last = sc;
    window.__frames.push({
      t: Math.round(performance.now() - window.__t0),
      sc,
      frame: sc * 192,
    });
  };
  window.__framesObs = new MutationObserver(push);
  window.__framesObs.observe(root, { attributes: true, attributeFilter: ['style'] });
  return true;
})()`;

const COLLECT = `(() => {
  const f = window.__frames ?? [];
  window.__framesObs?.disconnect();
  return f;
})()`;

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(TMP, { recursive: true });
  const server = await serve(HTTP_PORT);

  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    `--window-size=${W},${H}`,
    `--user-data-dir=${TMP}/cdp-scrub-frames`,
    `--breakpad-dump-location=${TMP}/crash-scrub`,
    `--remote-debugging-port=${CDP_PORT}`,
    `http://127.0.0.1:${HTTP_PORT}/?v=${Date.now()}`,
  ], { stdio: 'ignore', env: { ...process.env, HOME: '/home/vii' } });

  let ws;
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        targets = await cdp(CDP_PORT, '/json/list');
        if (targets?.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
      } catch {}
    }
    if (!targets) throw new Error('CDP 未就绪');

    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', j, { once: true });
    });
    const s = new Session(ws);
    await s.send('Runtime.enable');
    await s.send('Page.enable');

    for (let i = 0; i < 40; i++) {
      const r = await s.send('Runtime.evaluate', { expression: '!!document.querySelector(".stage")', returnByValue: true });
      if (r.result?.value) break;
      await sleep(200);
    }
    await sleep(1200); // 等素材加载

    await s.send('Runtime.evaluate', { expression: INSTALL, returnByValue: true });

    /* 拖动：分 N 次派发真实 wheel，每次一小步、间隔一帧。
     * 两种模式：
     *   slow —— 每步 1.6 帧、间隔 16ms：检"匀速慢拖"是否逐帧连续；
     *   fast —— 每步 20 帧、间隔 16ms：检"快速拖动"的每渲染帧跨帧数
     *           （暴露 smoothTime 缓动的快进量）。
     * 用 argv[4] 选模式，默认 slow。 */
    const mode = process.argv[4] ?? 'slow';
    const STEPS = mode === 'fast' ? 10 : 120;
    const STEP_DY = 2400 / (mode === 'fast' ? 10 : 120);
    for (let i = 0; i < STEPS; i++) {
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(W / 2),
        y: Math.round(H / 2),
        deltaX: 0,
        deltaY: STEP_DY,
        pointerType: 'mouse',
      });
      await sleep(16);
    }

    await sleep(1500); // 等缓动收敛

    const res = await s.send('Runtime.evaluate', { expression: COLLECT, returnByValue: true });
    const frames = res.result.value ?? [];

    await writeFile(join(OUT, `scrub-frames-${W}x${H}.json`), JSON.stringify(frames, null, 2));

    // 分析
    let monotonic = true;
    let maxJump = 0, maxJumpAt = 0;
    let stalls = [];
    let prev = null;
    for (const f of frames) {
      if (prev != null) {
        const d = f.frame - prev.frame;
        if (d < -0.01) monotonic = false;
        if (Math.abs(d) > Math.abs(maxJump)) { maxJump = d; maxJumpAt = f.frame; }
        if (Math.abs(d) < 0.001) stalls.push(f.t);
      }
      prev = f;
    }

    const first = frames[0], last = frames[frames.length - 1];
    console.log(`视口 ${W}×${H}  |  采样 ${frames.length} 次 --sc 写入（= render 回调次数）`);
    console.log('');
    console.log(`首帧 f${first?.frame.toFixed(1)} (t=${first?.t}ms)`);
    console.log(`末帧 f${last?.frame.toFixed(1)} (t=${last?.t}ms)`);
    console.log(`单调递增: ${monotonic ? '✅ 是' : '❌ 否（有回退）'}`);
    console.log(`最大单步跳变: ${maxJump.toFixed(1)} 帧（出现在 f${maxJumpAt.toFixed(0)}）`);
    console.log('');
    // 分布：每步跳几个帧
    const hist = new Map();
    prev = null;
    for (const f of frames) {
      if (prev != null) {
        const d = Math.round(Math.abs(f.frame - prev.frame));
        hist.set(d, (hist.get(d) ?? 0) + 1);
      }
      prev = f;
    }
    console.log('每渲染帧前进的帧数分布：');
    for (const [d, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  +${d} 帧 : ${n} 次`);
    }
    console.log('');
    // 平均每渲染帧的 dt
    const dts = [];
    for (let i = 1; i < frames.length; i++) dts.push(frames[i].t - frames[i - 1].t);
    dts.sort((a, b) => a - b);
    const med = dts[Math.floor(dts.length / 2)] ?? 0;
    console.log(`渲染帧间隔中位数: ${med}ms（≈${(1000 / Math.max(1, med)).toFixed(0)}fps）`);
    console.log(`渲染帧间隔 max: ${dts[dts.length - 1] ?? 0}ms`);
    console.log(`停顿（Δ<0.001）次数: ${stalls.length}`);
    console.log('');
    console.log(`报告：qa/out/scrub-frames-${W}x${H}.json`);
  } finally {
    ws?.close();
    chrome.kill('SIGKILL');
    server.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('测量失败：', e.message);
    process.exit(1);
  }
);
