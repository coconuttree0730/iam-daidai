// 版式探针：不截图，只报数字。
//   1. 每张卡的四角多边形（用 getBoxQuads，避免 AABB 把旋转卡片算大一圈）
//   2. 卡片中心到"头部中心"的距离与极角 → 量化"平衡"
//   3. 卡片多边形 ∩ 标题字（PERSONAL / ARCHIVE / 个人档案馆）→ 量化"压字"
//   4. 鼠标移动 / 悬停时，卡片中心的位移 → 量化"乱跳"
//
// 用法: node qa/probe.mjs [W] [H]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = '/home/vii/Projects/workspace-dev/my-project/my/iam-daidai/dist';
const W = Number(process.argv[2] || 1920);
const H = Number(process.argv[3] || 1080);
const PORT = 9700 + (process.pid % 150);
mkdirSync('/home/vii/.tmp', { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = join(DIST, p);
  if (!existsSync(fp) || statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('content-type', TYPES[extname(fp)] || 'application/octet-stream');
  res.end(readFileSync(fp));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const env = { ...process.env, HOME: '/home/vii', TMPDIR: '/home/vii/.tmp' };
const HOME_DIR = `/home/vii/.tmp/chrome-probe-${process.pid}`;
rmSync(HOME_DIR, { recursive: true, force: true });
const CDP_PORT = PORT + 1000;
const chrome = spawn('google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${HOME_DIR}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { env, stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
}
if (!ver) { console.error('chrome not ready'); process.exit(1); }

const t = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  const h = (e) => { const m = JSON.parse(e.data); if (m.id !== mid) return;
    ws.removeEventListener('message', h); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJS = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(3000);

// 页面内注入工具函数
await evalJS(`
window.__poly = (el) => {
  if (el.getBoxQuads) {
    const q = el.getBoxQuads({ box: 'border' })[0];
    return [q.p1, q.p2, q.p3, q.p4].map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) }));
  }
  const r = el.getBoundingClientRect();
  return [{x:r.left,y:r.top},{x:r.right,y:r.top},{x:r.right,y:r.bottom},{x:r.left,y:r.bottom}]
    .map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) }));
};
window.__ctr = (poly) => ({ x: poly.reduce((s,p)=>s+p.x,0)/4, y: poly.reduce((s,p)=>s+p.y,0)/4 });
window.__rect = (el) => { const r = el.getBoundingClientRect();
  return { l:+r.left.toFixed(1), t:+r.top.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1), cx:+((r.left+r.right)/2).toFixed(1), cy:+((r.top+r.bottom)/2).toFixed(1) }; };
// 多边形 ∩ 矩形（分离轴，多边形按矩形化处理：逐边法向 + 两轴）
window.__hit = (poly, rect) => {
  const rx = [rect.l, rect.r], ry = [rect.t, rect.b];
  const np = poly.length;
  const normals = [{x:1,y:0},{x:0,y:1}];
  for (let i = 0; i < np; i++) {
    const a = poly[i], b = poly[(i+1)%np];
    const nx = -(b.y - a.y), ny = (b.x - a.x);
    const L = Math.hypot(nx, ny) || 1;
    normals.push({ x: nx/L, y: ny/L });
  }
  const proj = (pts, n) => pts.map(p => p.x*n.x + p.y*n.y);
  const corners = [{x:rx[0],y:ry[0]},{x:rx[1],y:ry[0]},{x:rx[1],y:ry[1]},{x:rx[0],y:ry[1]}];
  for (const n of normals) {
    const a = proj(poly, n), b = proj(corners, n);
    if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
  }
  return true;
};
1`);

const snap = () => evalJS(`(() => {
  const card = (el) => ({ no: el.querySelector('.card-no').textContent.trim(),
    theta: getComputedStyle(el).getPropertyValue('--theta').trim(),
    poly: window.__poly(el), ...window.__ctr(window.__poly(el)) });
  return { cards: [...document.querySelectorAll('.card')].map(card) };
})()`);

const base = await snap();

const info = await evalJS(`(() => {
  const stage = document.querySelector('.stage');
  const cs = getComputedStyle(stage);
  const fig = document.querySelector('.hero-figure').getBoundingClientRect();
  const box = (k) => { const e = document.querySelector(k); return e ? window.__rect(e) : null; };
  const hit = (sel) => [...document.querySelectorAll('.card')].map(el => {
    const p = window.__poly(el); const r = window.__rect(document.querySelector(sel));
    return { no: el.querySelector('.card-no').textContent.trim(), hit: window.__hit(p, r) };
  });
  return {
    view: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
            scrollBar: innerWidth - document.documentElement.clientWidth,
            docH: document.documentElement.scrollHeight },
    vars: ['--design-h','--fan-r','--fan-pivot-y','--card-h','--figure-h','--solid-size','--ghost-top']
      .reduce((o,k)=>(o[k]=cs.getPropertyValue(k).trim(), o), {}),
    resolved: {
      fanR: getComputedStyle(document.querySelector('.card')).getPropertyValue('--fan-r').trim(),
    },
    figure: { x:+fig.x.toFixed(1), y:+fig.y.toFixed(1), w:+fig.width.toFixed(1), h:+fig.height.toFixed(1) },
    titleEnLeft: box('.title-en .w-left'), titleEnRight: box('.title-en .w-right'),
    titleZh: box('.title-zh'), ghost: box('.ghost'), infobar: box('.infobar'),
    markTl: box('.mark-tl'), markTr: box('.mark-tr'), sideIndex: box('.side-index'), markBr: box('.mark-br'),
    collide: {
      enLeft: hit('.title-en .w-left'), enRight: hit('.title-en .w-right'), zh: hit('.title-zh'),
    },
  };
})()`);

console.log(`\n===== ${W}x${H} =====`);
console.log(JSON.stringify(info, null, 2));

// 头部中心：立绘盒中心偏上（墨迹 ≈ 单格 97.3%，头顶从盒顶往下约 2.7%）
const headTop = info.figure.y;
const headCx = info.figure.x + info.figure.w / 2;
const headCy = headTop + info.figure.h * 0.11;

console.log('\n--- 卡片相对头部中心：距离 / 极角（0°=正上方，+右） ---');
for (const c of base.cards) {
  const dx = c.x - headCx, dy = c.y - headCy;
  const dist = Math.hypot(dx, dy);
  const ang = Math.atan2(dx, -dy) * 180 / Math.PI;
  console.log(`  ${c.no}  θ=${c.theta.padStart(7)}  中心=(${c.x.toFixed(0)},${c.y.toFixed(0)})  距头心=${dist.toFixed(0)}px  极角=${ang.toFixed(1)}°`);
}
console.log(`  头部中心 ≈ (${headCx.toFixed(0)}, ${headCy.toFixed(0)})  头顶 y=${headTop.toFixed(0)}`);

// 鼠标稳定性测试
console.log('\n--- 鼠标移动 / 悬停稳定性 ---');
const pts = [
  ['中性(左下)', 40, H - 160],
  ['卡片01中心', base.cards[0].x, base.cards[0].y],
  ['卡片02中心', base.cards[1].x, base.cards[1].y],
  ['卡片03中心', base.cards[2].x, base.cards[2].y],
  ['卡片04中心', base.cards[3].x, base.cards[3].y],
  ['画面中心', W / 2, H / 2],
];
let worst = 0;
for (const [label, x, y] of pts) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(700);
  const after = await snap();
  const moves = after.cards.map((c, i) => {
    const b = base.cards[i];
    return { no: c.no, d: +Math.hypot(c.x - b.x, c.y - b.y).toFixed(1) };
  });
  const mx = Math.max(...moves.map((m) => m.d));
  worst = Math.max(worst, mx);
  console.log(`  ${label.padEnd(12)} 最大位移 ${String(mx).padStart(6)}px   ` + moves.map((m) => `${m.no}:${m.d}`).join(' '));
}
console.log(`  → 最大单品位移 ${worst}px`);

/* 标题横向溢出：mobile 档英文标题是 space-between 的两词，
   字号必须让 15 个字符放进 100vw−左右边距，否则被 overflow:hidden 裁掉。 */
const overflow = await evalJS(`(() => {
  const l = document.querySelector('.title-en .w-left').getBoundingClientRect();
  const r = document.querySelector('.title-en .w-right').getBoundingClientRect();
  return { left: +l.left.toFixed(1), right: +r.right.toFixed(1), gap: +(r.left - l.right).toFixed(1),
           vw: innerWidth };
})()`);
console.log(`\n--- 英文标题横向 ---`);
console.log(`  左词 x ${overflow.left} … 右词 x ${overflow.right}  (视口宽 ${overflow.vw})  两词间隙 ${overflow.gap}px`);
const overflowBad = overflow.left < 0 || overflow.right > overflow.vw || overflow.gap < 0;
console.log(`  ${overflowBad ? '✗ 溢出/重叠' : '✓ 在视口内且不重叠'}`);

/* 硬判定：
   A 悬停位移必须 ≤ 卡高 × 0.35（正常只应是 --py-lift ≈ 0.14·卡高）
   B 标题不得溢出/自重叠 */
const cardH = await evalJS(`document.querySelector('.card').offsetHeight`);
const driftBad = worst > cardH * 0.35;
console.log(`\n判定：悬停位移 ${worst}px vs 上限 ${(cardH * 0.35).toFixed(1)}px → ${driftBad ? '✗ FAIL' : '✓ ok'}`
  + `   标题 ${overflowBad ? '✗ FAIL' : '✓ ok'}`);

ws.close(); server.close(); chrome.kill('SIGKILL');
await sleep(300);
rmSync(HOME_DIR, { recursive: true, force: true });
process.exit(driftBad || overflowBad ? 1 : 0);
