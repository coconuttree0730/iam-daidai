// 单次截图: 在 snap 进程内嵌一个 HTTP server 与 chrome,完全 in-process
// 用法:  node qa/snap.mjs <W> <H> [out.png]   (URL 写死为 file://,零网络依赖)
import { writeFileSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = '/home/vii/Projects/workspace-dev/my-project/my/iam-daidai/dist';
const W = Number(process.argv[2]);
const H = Number(process.argv[3]);
const OUT = process.argv[4] || `/home/vii/Projects/workspace-dev/my-project/my/iam-daidai/qa/out/snap-${W}x${H}.png`;
const PORT = 9370 + (process.pid % 200);
mkdirSync('/home/vii/.tmp', { recursive: true });
mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });

// 内嵌 HTTP server,直读 dist 目录
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = join(DIST, p);
  if (!existsSync(fp)) { res.statusCode = 404; res.end('not found'); return; }
  if (statSync(fp).isDirectory()) { res.statusCode = 404; res.end(); return; }
  const buf = readFileSync(fp);
  res.setHeader('content-type', TYPES[extname(fp)] || 'application/octet-stream');
  res.end(buf);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`http server up on :${PORT}`);

const env = { ...process.env, HOME: '/home/vii', TMPDIR: '/home/vii/.tmp' };
const HOME_DIR = `/home/vii/.tmp/chrome-shot-${process.pid}`;
rmSync(HOME_DIR, { recursive: true, force: true });

const CDP_PORT = PORT + 1000;
const chrome = spawn(
  'google-chrome-stable',
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    /* 本机设了 HTTP_PROXY，Chrome 的导航也会走它 → 发往 127.0.0.1 的请求被
       代理接管、偶发 502，页面渲染成空白，evaluate 就报 {err:'no stage'}。 */
    '--no-proxy-server',
    `--user-data-dir=${HOME_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { env, stdio: ['ignore', 'ignore', 'pipe'] }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 就绪预算 30s（原 15s）。Chrome 冷启动在负载高时会超过 15s，
   表现为 "chrome not ready"，让人误以为脚本坏了——实测偶发。 */
let versionResp = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) { versionResp = await r.json(); break; }
  } catch {}
}
if (!versionResp) {
  console.error('chrome not ready');
  server.close(); chrome.kill('SIGKILL');
  process.exit(1);
}
console.log(`chrome ${versionResp.Browser}`);

const t = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: W < 700,
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

/* 轮询到 .stage 真正挂上再截图，不用固定 sleep。
   固定 3500ms 在"导航被代理吞掉"时也照样往下走，会存下一张空白图
   （3KB），后面所有基于这张图的分析全是垃圾——必须把"页面到底加载了
   没有"本身写成断言。 */
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `!!document.querySelector('.stage') && document.readyState === 'complete'`,
    });
    if (r.result?.value === true) { ready = true; break; }
  } catch {}
}
if (!ready) {
  console.error('页面未加载：.stage 在 10s 内没有出现（多半是代理吃掉了 127.0.0.1 的导航）');
  ws.close(); server.close(); chrome.kill('SIGKILL');
  process.exit(1);
}
/* 字体/图集解码完再截，否则首屏可能拍到未排版的字。 */
await sleep(600);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`saved ${OUT} (${(shot.data.length * 0.75 / 1024).toFixed(0)}KB raw)`);

const geo = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const stage = document.querySelector('.stage');
    if (!stage) return { err: 'no stage' };
    const cs = getComputedStyle(stage);
    const out = {};
    out.cs = ['--design-h','--fan-r','--card-h','--figure-h','--figure-pad','--ghost-top','--solid-size','--zh-bottom']
      .reduce((o, k) => (o[k] = cs.getPropertyValue(k).trim(), o), {});
    const fig = document.querySelector('.hero-figure').getBoundingClientRect();
    out.fig = { y: +fig.y.toFixed(1), h: +fig.height.toFixed(1), x: +fig.x.toFixed(1), w: +fig.width.toFixed(1) };
    out.cards = [...document.querySelectorAll('.card')].map((el) => {
      const r = el.getBoundingClientRect();
      return { no: el.querySelector('.card-no').textContent.trim(),
               theta: getComputedStyle(el).getPropertyValue('--theta').trim(),
               l: +r.left.toFixed(1), t: +r.top.toFixed(1),
               r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) };
    });
    return out;
  })()`,
});
console.log(JSON.stringify(geo.result.value, null, 2));

ws.close();
server.close();
chrome.kill('SIGKILL');
await sleep(300);
rmSync(HOME_DIR, { recursive: true, force: true });
process.exit(0);
