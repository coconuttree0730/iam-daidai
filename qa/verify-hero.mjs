/* CDP 验收 v2：修正 v1 的两处测试方法错误
 *
 * v1 的两个"失败"经查是探针自身的问题：
 *   1) 单调性用 background-position 的 X 百分比判断是错的——图集按行折返，
 *      col 越过 7 会回到 0，X 百分比必然回跌。正确做法是把 (col,row) 解码回帧号再判。
 *   2) 确定性测试把"从下方逼近 22.5"和"从上方逼近 22.5"比了哈希。position 是
 *      渐近收敛且不触发 snap，同一目标从不同方向收敛会停在 22.498 / 22.502，
 *      Math.round 后差 1 帧。要测确定性必须同向逼近，并另用非边界值复测。
 *
 * 用法： CDP_PORT=9346 node qa/verify-hero.mjs <URL> <outdir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2];
const OUT = process.argv[3] ?? 'qa/out';
const PORT = process.env.CDP_PORT ?? '9346';
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

const hash = (buf) => {
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = (h * 31 + buf[i]) >>> 0;
  return h.toString(16);
};

const page = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()))
  .find((t) => t.type === 'page');
if (!page) throw new Error('没有找到 type=page 的 target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const send = connect(ws);

const exceptions = [];
const consoleErrors = [];
const failedRequests = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push(d.exception?.description ?? d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    failedRequests.push({ url: m.params.response.url, status: m.params.response.status,
                          type: m.params.type });
  }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

const VW = 1600, VH = 900, COLS = 8, ROWS = 6, FRAMES = 46;
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ });
await sleep(4000);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

/* 把 background-position 百分比解码回帧号 */
const decodeFrame = (bg) => {
  const [xp, yp] = bg.split(' ').map(parseFloat);
  const col = Math.round((xp / 100) * (COLS - 1));
  const row = Math.round((yp / 100) * (ROWS - 1));
  return row * COLS + col;
};

const dom = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             cx: +(r.x + r.width / 2).toFixed(1), cy: +(r.y + r.height / 2).toFixed(1) }; };
  const stage = q('[data-sprite-view]');
  const sprite = q('[data-sprite]');
  const cs = sprite ? getComputedStyle(sprite) : null;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  return {
    viewport: { w: innerWidth, h: innerHeight },
    stage: rect(stage),
    figure: rect(sprite),
    spriteBg: cs ? { position: cs.backgroundPosition, size: cs.backgroundSize,
                     image: cs.backgroundImage.slice(0, 70) } : null,
    bodyBg,
    cards: [...document.querySelectorAll('[data-depth]')].map((el) => ({
      depth: el.dataset.depth, href: el.getAttribute('href'), no: el.querySelector('.card-no')?.textContent.trim(),
      title: el.querySelector('.card-title')?.textContent.trim(), rect: rect(el),
    })),
    ghost: (() => { const g = q('.ghost'); return g ? { text: g.textContent.trim(), fontSize: getComputedStyle(g).fontSize, rect: rect(g) } : null; })(),
    titleZh: q('.title-zh')?.textContent.trim() ?? null,
    infobar: (() => { const b = q('.infobar'); return b ? { rect: rect(b),
      items: [...b.children].map((c) => ({ text: c.textContent.replace(/\\s+/g,' ').trim(),
        placeholder: c.hasAttribute('data-placeholder') })) } : null; })(),
    marks: ['mark-tl','mark-tr','side-index','mark-br','mark-bl'].map((c) => {
      const el = q('.' + c); return { class: c, present: !!el, rect: rect(el) }; }),
    fonts: { anton: document.fonts.check('16px Anton'),
             archivo: document.fonts.check('16px "Archivo Black"'),
             vibes: document.fonts.check('16px "Great Vibes"'), status: document.fonts.status,
             size: document.fonts.size },
    scroll: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
              cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight },
  };
})()`);

const stage = dom.stage;
const toClientX = (t) => stage.x + Math.min(0.999, Math.max(0.001, t)) * stage.w;

const probe = async (t, tag, shot = true) => {
  const cx = toClientX(t);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: stage.y + stage.h * 0.55, button: 'none' });
  await sleep(1300);
  const st = await evaluate(`(() => {
    const cs = getComputedStyle(document.querySelector('[data-sprite]'));
    const f = document.querySelector('[data-frame]');
    return { bgPosition: cs.backgroundPosition, frameLabel: f ? f.textContent.trim() : null,
      cards: [...document.querySelectorAll('[data-depth]')].map((el) => ({
        depth: el.dataset.depth, px: el.style.getPropertyValue('--px'), py: el.style.getPropertyValue('--py') })) };
  })()`);
  let h = null, bytes = 0, file = null;
  if (shot) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(s.data, 'base64');
    h = hash(buf); bytes = buf.length; file = `${tag}.png`;
    writeFileSync(`${OUT}/${file}`, buf);
  }
  return { t, tag, clientX: +cx.toFixed(1), ...st, frame: decodeFrame(st.bgPosition), hash: h, bytes, file };
};

/* ---- A. 扫描：帧随动单调性 ---- */
const scan = [];
for (const t of [0, 0.25, 0.5, 0.75, 1]) scan.push(await probe(t, `scan-t${Math.round(t * 100)}`));

/* ---- B. 确定性：同向逼近，非边界值 ---- */
await probe(0.2, 'warm', false);
const d1 = await probe(0.4, 'det-a');
await probe(0.2, 'reset', false);
const d2 = await probe(0.4, 'det-b');

/* ---- C. 边界行为：0.5 恰好落在 22.5，分别从上下逼近 ---- */
await probe(0.1, 'below', false);
const above = await probe(0.5, 'bound-below', false);
await probe(0.9, 'above', false);
const below = await probe(0.5, 'bound-above', false);

/* ---- D. pointerleave 归位 ---- */
await probe(1, 'before-leave', false);
await evaluate(`document.querySelector('[data-sprite-view]').dispatchEvent(new PointerEvent('pointerleave', {bubbles:true}))`);
await sleep(1300);
const afterLeave = await evaluate(`getComputedStyle(document.querySelector('[data-sprite]')).backgroundPosition`);
const leaveFrame = decodeFrame(afterLeave);

/* ---- E. 卡片视差方向性 ---- */
await probe(0.15, 'left-edge', false);
const leftPx = await evaluate(`getComputedStyle(document.querySelector('[data-depth]')).getPropertyValue('--px')`);
await probe(0.85, 'right-edge', false);
const rightPx = await evaluate(`getComputedStyle(document.querySelector('[data-depth]')).getPropertyValue('--px')`);

const frames = scan.map((s) => s.frame);
const mono = frames.every((f, i) => i === 0 || f >= frames[i - 1]);
const expected = scan.map((s) => Math.round(s.t * (FRAMES - 1)));
const maxDev = Math.max(...frames.map((f, i) => Math.abs(f - expected[i])));

const report = {
  url: URL_, viewport: dom.viewport,
  dom, scan,
  determinism: { a: { t: d1.t, frame: d1.frame, hash: d1.hash }, b: { t: d2.t, frame: d2.frame, hash: d2.hash },
                 sameDirectionReproducible: d1.frame === d2.frame && d1.hash === d2.hash },
  boundary: { approachedFromBelow: above.frame, approachedFromAbove: below.frame,
              delta: Math.abs(above.frame - below.frame) },
  leave: { afterLeaveBg: afterLeave, frame: leaveFrame, returnsToRest: leaveFrame === 0 },
  parallax: { leftPx, rightPx, signFlips: parseFloat(leftPx) < 0 && parseFloat(rightPx) > 0 },
  failedRequests, exceptions, consoleErrors,
  verdict: {
    '无 JS 异常': exceptions.length === 0,
    '无非预期请求失败': failedRequests.filter((r) => !r.url.includes('favicon')).length === 0,
    '立绘尺寸非零': !!dom.figure && dom.figure.w > 50 && dom.figure.h > 50,
    '图集已载入': !!dom.spriteBg && dom.spriteBg.image.includes('atlas'),
    '帧随动单调不减': mono,
    '帧号契合 progress*(n-1)': maxDev <= 1,
    '同向采样可复现': d1.frame === d2.frame && d1.hash === d2.hash,
    'pointerleave 回到 0 帧': leaveFrame === 0,
    '视差随指针换向': parseFloat(leftPx) < 0 && parseFloat(rightPx) > 0,
    '四张卡片齐备': dom.cards.length === 4,
    '卡片含编号与标题': dom.cards.every((c) => c.no && c.title),
    '卡片扇形内无溢出': dom.cards.every((c) => c.rect.x > -2 && c.rect.x + c.rect.w < VW + 2 && c.rect.y > -2),
    '装饰件齐备': dom.marks.filter((m) => m.present).length === 5,
    '字体全部就绪': dom.fonts.anton && dom.fonts.archivo && dom.fonts.vibes,
    '底栏渲染': (dom.infobar?.items.length ?? 0) >= 4,
    '页面无多余滚动': dom.scroll.sh <= dom.scroll.ch + 2 && dom.scroll.sw <= dom.scroll.cw + 2,
  },
};
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

const pass = Object.values(report.verdict).filter(Boolean).length;
const total = Object.values(report.verdict).length;
console.log(`\n=== hero 验收 v2  ${pass}/${total} 通过 ===`);
for (const [k, v] of Object.entries(report.verdict)) console.log(`  ${v ? '✅' : '❌'} ${k}`);

console.log('\n--- 帧随动扫描 (t → 帧号) ---');
scan.forEach((s, i) => console.log(`  t=${s.t}  bg="${s.bgPosition}"  frame=${s.frame}  期望=${expected[i]}  偏差=${Math.abs(s.frame - expected[i])}  hash=${s.hash}`));
console.log(`  单调不减: ${mono}   最大偏差: ${maxDev}`);

console.log('\n--- 确定性(同向逼近 t=0.4) ---');
console.log(`  a: frame=${d1.frame} hash=${d1.hash}`);
console.log(`  b: frame=${d2.frame} hash=${d2.hash}  → ${report.determinism.sameDirectionReproducible ? '可复现' : '不可复现'}`);

console.log('\n--- 边界 0.5 (目标 22.5) ---');
console.log(`  从下逼近 → 帧 ${above.frame}   从上逼近 → 帧 ${below.frame}   差 ${report.boundary.delta}`);

console.log('\n--- pointerleave ---');
console.log(`  bg="${afterLeave}" → 帧 ${leaveFrame}  ${leaveFrame === 0 ? '(已归位)' : '(未归位)'}`);

console.log('\n--- 视差方向 ---');
console.log(`  指针在左 --px=${leftPx}   指针在右 --px=${rightPx}`);

console.log('\n--- 卡片几何 ---');
dom.cards.forEach((c) => console.log(`  ${c.no} ${c.title}  depth=${c.depth}  href=${c.href}  中心=(${c.rect.cx},${c.rect.cy})  尺寸=${c.rect.w}x${c.rect.h}`));

console.log('\n--- 装饰件 ---');
dom.marks.forEach((m) => console.log(`  ${m.present ? '✅' : '❌'} .${m.class}  ${m.rect ? `中心=(${m.rect.cx},${m.rect.cy})` : ''}`));

if (failedRequests.length) console.log('\n--- 请求失败 ---', JSON.stringify(failedRequests, null, 2));
if (exceptions.length) console.log('\n⚠ exceptions:', exceptions);
if (consoleErrors.length) console.log('⚠ consoleErrors:', consoleErrors);
console.log(`\n截图与报告: ${OUT}/`);
ws.close();
process.exit(pass === total ? 0 : 1);
