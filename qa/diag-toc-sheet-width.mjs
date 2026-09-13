// 诊断：大纲 sheet 的「宽度为什么不是视口宽」（不截图，只报数字）。
//   用户报告：≤640px 档面板没铺满、右侧留了一条缝。
//   静态推理（inset:auto 0 0 0 + width:auto + margin:0 → 必然铺满视口）与
//   截图矛盾，所以这里取真实数字：视口宽度 / 媒体查询命中 / 命中规则 /
//   计算值 / 边框盒四边形。
//
// 用法: node qa/diag-toc-sheet-width.mjs [312-核心原则两个负载 之类的 slug]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import http from 'node:http';
import { join, extname } from 'node:path';

const DIST = '/home/vii/Projects/workspace-dev/my-project/my/iam-daidai/dist';
const SLUG = process.argv[2] || 'how-to-write-agents-md';
const PORT = 9800 + (process.pid % 150);
mkdirSync('/home/vii/.tmp', { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const fp = join(DIST, p);
  if (!existsSync(fp) || statSync(fp).isDirectory()) {
    res.statusCode = 404;
    res.end('nf');
    return;
  }
  res.setHeader('content-type', TYPES[extname(fp)] || 'application/octet-stream');
  res.end(readFileSync(fp));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const env = { ...process.env, HOME: '/home/vii', TMPDIR: '/home/vii/.tmp' };
const HOME_DIR = `/home/vii/.tmp/chrome-toc-w-${process.pid}`;
rmSync(HOME_DIR, { recursive: true, force: true });
const CDP_PORT = PORT + 1000;
const chrome = spawn(
  'google-chrome-stable',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${HOME_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { env, stdio: ['ignore', 'ignore', 'pipe'] }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) {
      ver = await r.json();
      break;
    }
  } catch {}
}
if (!ver) {
  console.error('chrome not ready');
  process.exit(1);
}

const target = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())).find(
  (x) => x.type === 'page'
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', h);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evalJS = async (expr) =>
  (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }))
    .result.value;

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('CSS.enable');

const PROBE = `
(() => {
  const s = document.querySelector('[data-toc-sheet]');
  if (!s) return { err: 'no sheet' };
  const cs = getComputedStyle(s);
  const r = s.getBoundingClientRect();
  const quads = s.getBoxQuads ? s.getBoxQuads({ box: 'border' })[0] : null;
  const openBtn = document.querySelector('[data-toc-open]');
  return {
    open: s.open,
    hidden: s.hasAttribute('hidden'),
    tocBtnHidden: openBtn ? openBtn.hasAttribute('hidden') : null,
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    visualWidth: window.visualViewport ? +window.visualViewport.width.toFixed(2) : null,
    scrollbarW: window.innerWidth - document.documentElement.clientWidth,
    mq640: matchMedia('(max-width: 640px)').matches,
    mq641: matchMedia('(min-width: 641px)').matches,
    dpr: window.devicePixelRatio,
    rect: { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2) },
    quad: quads ? { l: +quads.p1.x.toFixed(2), r: +quads.p2.x.toFixed(2) } : null,
    css: {
      position: cs.position, display: cs.display, width: cs.width, minWidth: cs.minWidth,
      maxWidth: cs.maxWidth, margin: cs.margin, left: cs.left, right: cs.right,
      inset: cs.inset, borderRadius: cs.borderRadius, borderTopWidth: cs.borderTopWidth,
      borderLeftWidth: cs.borderLeftWidth, boxSizing: cs.boxSizing, transform: cs.transform,
      animation: cs.animationName,
    },
    parent: s.parentElement ? s.parentElement.className : null,
    topLayer: (() => {
      // dialog 是否真的在 top-layer：:modal 伪类只在 modal 时命中
      try { return s.matches(':modal'); } catch { return 'n/a'; }
    })(),
  };
})()`;

const CASES = [
  [320, 720, '最小手机'],
  [390, 844, '常见手机'],
  [430, 932, '大号手机'],
  [640, 900, '断点边界（应命中）'],
  [641, 900, '断点外一像素'],
  [768, 1024, '平板'],
  [911, 844, '用户截图 2 的窗口'],
];

for (const [W, H, label] of CASES) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: W < 700,
  });
  await send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/blog/${SLUG}/index.html`,
  });
  await sleep(1200);
  await evalJS(`document.querySelector('[data-toc-open]')?.click(); 1`);
  await sleep(500);
  const out = await evalJS(PROBE);
  if (out && out.err) {
    console.log(`\n── ${label}  ${W}×${H} → ${out.err}（页面可能没加载成功）`);
    continue;
  }
  const gapL = out.rect ? out.rect.l : null;
  const gapR = out.rect ? +(out.innerWidth - out.rect.r).toFixed(2) : null;
  console.log(
    `\n── ${label}  ${W}×${H} ─────────────────────────────` +
      `\n   视口 innerWidth=${out.innerWidth} clientWidth=${out.clientWidth} ` +
      `scrollbar=${out.scrollbarW} visual=${out.visualWidth} dpr=${out.dpr}` +
      `\n   media: ≤640=${out.mq640}  ≥641=${out.mq641}   :modal=${out.topLayer}  open=${out.open}` +
      `\n   sheet 边框盒: l=${out.rect.l} r=${out.rect.r} w=${out.rect.w}  →  左缝=${gapL} 右缝=${gapR}` +
      `\n   计算值: width=${out.css.width} min=${out.css.minWidth} max=${out.css.maxWidth} ` +
      `margin=${out.css.margin} left=${out.css.left} right=${out.css.right} inset=${out.css.inset}` +
      `\n           border=${out.css.borderTopWidth}/${out.css.borderLeftWidth} radius=${out.css.borderRadius} ` +
      `position=${out.css.position} transform=${out.css.transform}`
  );
}

ws.close();
chrome.kill('SIGKILL');
server.close();
process.exit(0);
