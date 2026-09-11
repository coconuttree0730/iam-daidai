#!/usr/bin/env node
/* 收尾区块几何测量（语录 + 联系表单）
 *
 * 目的：为「两块内容移动停止在哪」提供实测坐标，避免靠截图估算。
 * 一次跑完，不循环多视口（用户只授权一次测量）。
 *
 * 量什么：
 *   1. --sc = 1（终态）时 .outro 与 .outro-contact 的 getBoundingClientRect
 *   2. 换算成相对视口的百分比（顶部占比 / 底部占比 / 左右），便于与用户截图对齐
 *   3. 元素高度、以及到底部黑条（.infobar）的净空
 *   4. data-outro 标记是否已打上（pointer-events 是否放开）
 *
 * 用法：node qa/diag-outro-geo.mjs [W] [H]     （默认 1200 675）
 * 前提：先 npm run build（本脚本读 dist/），自带起静态服务 + 无头 Chrome。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';

const W = Number(process.argv[2] ?? 1200);
const H = Number(process.argv[3] ?? 675);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'qa/out');
const TMP = join(ROOT, '.tmp');
const HTTP_PORT = 8917;
const CDP_PORT = 9361;

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
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
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

const PROBE = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const pct = (v, total) => Math.round((v / total) * 1000) / 10;
  const W = innerWidth, H = innerHeight;
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true, sel };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel,
      left: px(r.left), right: px(r.right), top: px(r.top), bottom: px(r.bottom),
      width: px(r.width), height: px(r.height),
      topPct: pct(r.top, H), bottomPct: pct(r.bottom, H),
      leftPct: pct(r.left, W), rightPct: pct(r.right, W),
      opacity: Number(cs.opacity).toFixed(3),
      translate: cs.translate,
      pointerEvents: cs.pointerEvents,
    };
  };
  const bar = document.querySelector('.infobar');
  const barTop = bar ? bar.getBoundingClientRect().top : null;
  const outro = pick('.outro');
  const contact = pick('.outro-contact');
  return {
    viewport: { W, H },
    sc: getComputedStyle(document.documentElement).getPropertyValue('--sc').trim(),
    dataOutro: document.documentElement.dataset.outro ?? null,
    barTop: barTop == null ? null : px(barTop),
    barTopPct: barTop == null ? null : pct(barTop, H),
    outro,
    contact,
    gapToBar: {
      outro: barTop != null && !outro.missing ? px(barTop - outro.bottom) : null,
      contact: barTop != null && !contact.missing ? px(barTop - contact.bottom) : null,
    },
  };
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
    `--user-data-dir=${TMP}/cdp-outro-geo`,
    `--breakpad-dump-location=${TMP}/crash-outro`,
    `--remote-debugging-port=${CDP_PORT}`,
    `http://127.0.0.1:${HTTP_PORT}/?v=${Date.now()}`,
  ], { stdio: 'ignore', env: { ...process.env, HOME: TMP } });

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

    // 等 .stage 出现
    for (let i = 0; i < 40; i++) {
      const r = await s.send('Runtime.evaluate', { expression: '!!document.querySelector(".stage")', returnByValue: true });
      if (r.result?.value) break;
      await sleep(200);
    }
    await sleep(900);

    // 推进到终态：直接写 --sc = 1（脚本会把 data-outro 打上）
    const setSc = `(() => {
      document.documentElement.style.setProperty('--sc', '1');
      return true;
    })()`;
    await s.send('Runtime.evaluate', { expression: setSc, returnByValue: true });
    await sleep(700); // 等 MutationObserver 打标记 + 过渡稳定

    const res = await s.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const data = res.result.value;

    await writeFile(join(OUT, `outro-geo-${W}x${H}.json`), JSON.stringify(data, null, 2));

    const fmt = (o) =>
      o.missing
        ? `  MISSING ${o.sel}`
        : `  top ${String(o.top).padStart(7)}px (${String(o.topPct).padStart(5)}%)   ` +
          `bottom ${String(o.bottom).padStart(7)}px (${String(o.bottomPct).padStart(5)}%)   ` +
          `h ${o.height}px   left ${o.left}px   right ${o.right}px`;

    console.log(`视口 ${W}×${H}  |  --sc = ${data.sc}  |  data-outro = ${data.dataOutro}`);
    console.log(`黑条顶 ${data.barTop}px (${data.barTopPct}%)`);
    console.log('');
    console.log('.outro（语录）');
    console.log(fmt(data.outro));
    console.log(`  到底部黑条净空 ${data.gapToBar.outro}px   opacity ${data.outro.opacity}   pointer-events ${data.outro.pointerEvents}`);
    console.log('');
    console.log('.outro-contact（联系表单）');
    console.log(fmt(data.contact));
    console.log(`  到底部黑条净空 ${data.gapToBar.contact}px   opacity ${data.contact.opacity}   pointer-events ${data.contact.pointerEvents}`);
    console.log('');
    console.log(`报告：qa/out/outro-geo-${W}x${H}.json`);
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
