/* 层叠与几何诊断
 *
 * 只回答两个问题，不做视觉审美判断：
 *   1) 在「人物包围盒 ∩ 卡片包围盒」的重叠区里，到底谁在最上层？
 *      方法：临时把 .hero-person/.fan/.card 的 pointer-events 强制为 auto，
 *      再用 elementsFromPoint 取绘制序（数组首项即最上层）。
 *      这样不依赖肉眼，也不受 pointer-events:none 干扰。
 *   2) 移动端断点下卡片扇形是否落在人物头部附近、是否溢出视口。
 *
 * 用法： CDP_PORT=9346 node qa/diag-layers.mjs <URL> <outdir> <W> <H>
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2];
const OUT = process.argv[3] ?? 'qa/out';
const W = Number(process.argv[4] ?? 1545);
const H = Number(process.argv[5] ?? 1075);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
const connect = (ws) => (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    const handler = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', handler);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const PORT = process.env.CDP_PORT ?? '9346';
const target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()))
  .find((t) => t.type === 'page');
if (!target) throw new Error('没有找到 type=page 的 target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const send = connect(ws);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: W < 700,
});
await send('Page.navigate', { url: URL_ });
await sleep(3500);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

const result = await evaluate(`(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             cx: +(r.x + r.width / 2).toFixed(1), cy: +(r.y + r.height / 2).toFixed(1),
             right: +(r.x + r.width).toFixed(1), bottom: +(r.y + r.height).toFixed(1) }; };
  const layer = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const cs = getComputedStyle(el);
    return { sel, zIndex: cs.zIndex, position: cs.position, rect: rect(el) }; };

  const layers = ['.ghost','.title','.hero-person','.hero-figure','.fan','.chrome','.infobar']
    .map(layer).filter(Boolean);

  const stage = document.querySelector('.stage');
  const cs = getComputedStyle(stage);
  const vars = {};
  for (const v of ['--fan-r','--fan-pivot-y','--card-h','--card-ratio','--figure-h',
                   '--ghost-top','--solid-baseline','--zh-bottom','--bar-h','--solid-size','--ghost-size']) {
    vars[v] = cs.getPropertyValue(v).trim();
  }

  const fig = document.querySelector('.hero-figure');
  const figRect = rect(fig);

  // 强制 pointer-events，使 elementsFromPoint 反映绘制序
  const style = document.createElement('style');
  style.textContent = '.hero-person,.hero-figure,.fan,.card{pointer-events:auto !important}';
  document.head.appendChild(style);

  const cards = [...document.querySelectorAll('.card')].map((el) => {
    const r = rect(el);
    // 在卡片包围盒内取样，只保留同时落在人物包围盒内的点
    const probes = [];
    for (let i = 1; i <= 7; i++) {
      for (let j = 1; j <= 5; j++) {
        const x = r.x + (r.w * i) / 8;
        const y = r.y + (r.h * j) / 6;
        if (x < figRect.x || x > figRect.right || y < figRect.y || y > figRect.bottom) continue;
        const stack = document.elementsFromPoint(x, y)
          .map((e) => e.className && typeof e.className === 'string' ? e.className.split(' ')[0] : e.tagName)
          .filter((c) => ['hero-person','hero-figure','card','fan','stage','ghost','title'].includes(c));
        if (!stack.includes('card')) continue;
        probes.push({ x: +x.toFixed(0), y: +y.toFixed(0), top: stack[0], stack: stack.slice(0, 4) });
      }
    }
    return {
      no: el.querySelector('.card-no')?.textContent.trim(),
      title: el.querySelector('.card-title')?.textContent.trim(),
      theta: getComputedStyle(el).getPropertyValue('--theta').trim(),
      rect: r,
      overlapsFigureBox: !(r.x > figRect.right || r.right < figRect.x || r.y > figRect.bottom || r.bottom < figRect.y),
      probes,
      cardAboveFigure: probes.length ? probes.filter((p) => p.top === 'card').length : null,
    };
  });

  style.remove();

  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    mediaMatches: { m1100: matchMedia('(max-width:1100px)').matches,
                    m900: matchMedia('(max-width:900px)').matches,
                    m640: matchMedia('(max-width:640px)').matches },
    vars, layers, figureRect: figRect, cards,
    scroll: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
              cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight },
  };
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const tag = `${W}x${H}`;
writeFileSync(`${OUT}/diag-${tag}.png`, Buffer.from(shot.data, 'base64'));
writeFileSync(`${OUT}/diag-${tag}.json`, JSON.stringify(result, null, 2));

console.log(`\n=== ${tag}  media: ${JSON.stringify(result.mediaMatches)} ===`);
console.log('--- CSS 变量 ---');
for (const [k, v] of Object.entries(result.vars)) console.log(`  ${k}: ${v}`);
console.log('--- 图层 (DOM 顺序 / z-index / 位置) ---');
for (const l of result.layers) {
  console.log(`  ${l.sel.padEnd(14)} z=${l.zIndex.padEnd(5)} ${l.position.padEnd(8)} rect=${l.rect ? `x${l.rect.x} y${l.rect.y} ${l.rect.w}x${l.rect.h}` : 'null'}`);
}
console.log(`--- 人物包围盒: y ${result.figureRect.y} → ${result.figureRect.bottom}  x ${result.figureRect.x} → ${result.figureRect.right} ---`);
console.log('--- 卡片 ---');
for (const c of result.cards) {
  const p = c.probes[0];
  console.log(`  ${c.no} ${c.title} θ=${c.theta} 中心=(${c.rect.cx},${c.rect.cy}) ${c.rect.w}x${c.rect.h}`);
  console.log(`     与人物包围盒相交=${c.overlapsFigureBox}  重叠取样点=${c.probes.length}  其中卡片在最上层=${c.cardAboveFigure ?? '-'}`);
  if (p) console.log(`     样例点(${p.x},${p.y}) 绘制序: ${p.stack.join(' > ')}`);
}
console.log(`--- 溢出检查: scrollWidth=${result.scroll.sw} clientWidth=${result.scroll.cw} scrollHeight=${result.scroll.sh} clientHeight=${result.scroll.ch} ---`);
console.log(`截图: ${OUT}/diag-${tag}.png\n`);
ws.close();
