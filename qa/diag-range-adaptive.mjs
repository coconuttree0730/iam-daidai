#!/usr/bin/env node
/* 输入设备自适应验证：分别用"滚轮量级"与"触摸板量级"的 deltaY 拖同一段距离，
 * 断言最终进度是否符合各自 RANGE 的预期。
 *
 * 判据（视口 1280×800）：
 *   触摸板档 RANGE = max(3600, 800×6) = 4800
 *   滚轮档   RANGE = 5200
 * 用 1000px 累计下滑：
 *   触摸板 → 预期 progress ≈ 1000/4800 = 20.8%
 *   滚轮   → 预期 progress ≈ 1000/5200 = 19.2%
 * （注意：不同设备若判到同一档，两者结果应一致；关键是**都比旧的 2400 小得多**）
 *
 * 用法：node qa/diag-range-adaptive.mjs [W] [H]
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
const TMP = '/home/vii/.tmp/iam-daidai-qa';
const HTTP_PORT = 8923;
const CDP_PORT = 9367;

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

const READ_SC = `(() => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sc').trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
})()`;

async function runCase(s, label, stepDy, steps, reload) {
  /* 每档独立测量：先重载页面，让 range 回到初始检测态（WHEEL_RANGE）。
     否则上一 case 切换后的档位会残留，两 case 互相污染。 */
  if (reload) {
    await s.send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const r = await s.send('Runtime.evaluate', { expression: '!!document.querySelector(".stage")', returnByValue: true });
      if (r.result?.value) break;
    }
    await sleep(1500); // 等素材加载
  }
  await sleep(600);
  const total = stepDy * steps;
  for (let i = 0; i < steps; i++) {
    await s.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(W / 2),
      y: Math.round(H / 2),
      deltaX: 0,
      deltaY: stepDy,
      pointerType: 'mouse',
    });
    await sleep(24);
  }
  await sleep(1400); // 等缓动收敛
  const res = await s.send('Runtime.evaluate', { expression: READ_SC, returnByValue: true });
  const sc = res.result.value;
  const impliedRange = sc > 0 ? total / sc : Infinity;
  console.log(`  ${label}`);
  console.log(`    累计输入 ${total}px（${steps} 次 × ${stepDy}px）`);
  console.log(`    最终 --sc = ${sc.toFixed(4)}  →  反解 RANGE = ${Math.round(impliedRange)}px`);
  console.log(`    进度 ${(sc * 100).toFixed(1)}%`);
  return { label, total, sc, impliedRange };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serve(HTTP_PORT);

  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    `--window-size=${W},${H}`,
    `--user-data-dir=${TMP}/cdp-range`,
    `--breakpad-dump-location=${TMP}/crash-range`,
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
    await sleep(1200);

    console.log(`视口 ${W}×${H}`);
    console.log(`预期档位：触摸板 RANGE=${Math.max(3600, H * 6)} / 滚轮 RANGE=5200（旧值 2400）`);
    console.log('');

    /* 触摸板量级：每次 5px，160 次 = 800px。5 < 40 → 判 trackpad */
    const trackpad = await runCase(s, '触摸板量级（5px/次）', 5, 160, true);
    console.log('');
    /* 滚轮量级：每次 100px，8 次 = 800px（等量对照，便于直接比进度）。
       100 >= 40 → 判 wheel。两 case 用**相同累计量**，进度比直接反映 RANGE 比。 */
    const wheel = await runCase(s, '滚轮量级（100px/次）', 100, 8, true);

    await writeFile(join(OUT, `range-adaptive-${W}x${H}.json`), JSON.stringify({ viewport: { W, H }, trackpad, wheel }, null, 2));

    console.log('');
    console.log('=== 判定 ===');
    const okT = trackpad.impliedRange > 4000 && trackpad.impliedRange < 5600;
    const okW = wheel.impliedRange > 4400 && wheel.impliedRange < 6000;
    console.log(`触摸板档反解在 [4000,5600]: ${okT ? '✅' : '❌'} (${Math.round(trackpad.impliedRange)})`);
    console.log(`滚轮档反解在 [4400,6000]:   ${okW ? '✅' : '❌'} (${Math.round(wheel.impliedRange)})`);
    console.log(`两档都远大于旧值 2400:      ${trackpad.impliedRange > 2400 && wheel.impliedRange > 2400 ? '✅' : '❌'}`);
    console.log('');
    console.log(`报告：qa/out/range-adaptive-${W}x${H}.json`);
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
