/* 测量描边大字 .ghost 与 side-index 的实际几何
 *
 * 用户需求：
 *   1) 描边大字初始位置往右偏移 40px 或更多
 *   2) 当前在默认屏幕比例下显示不完整
 *   3) side-index（绿色框选的图形）应位于描边大字上方
 *
 * 本脚本量出：ghost 的字面宽度 / 左右边界（是否超出视口）、
 * side-index 的矩形、以及两者的垂直关系。
 *
 * 用法： CDP_PORT=9354 node qa/diag-ghost-geo.mjs <URL> <outdir> <W> <H>
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2];
const OUT = process.argv[3] ?? 'qa/out';
const W = Number(process.argv[4] ?? 1080);
const H = Number(process.argv[5] ?? 608);
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

const PORT = process.env.CDP_PORT ?? '9354';
const target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()))
  .find((t) => t.type === 'page');
if (!target) throw new Error('没有找到 type=page 的 target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const send = connect(ws);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: URL_ });
await sleep(3000);

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const MEASURE = `(() => {
  const g = document.querySelector('.ghost');
  const si = document.querySelector('.side-index');
  const stage = document.querySelector('.stage');
  const gr = g ? g.getBoundingClientRect() : null;
  const sr = si ? si.getBoundingClientRect() : null;
  const st = stage.getBoundingClientRect();
  const cs = g ? getComputedStyle(g) : null;
  return {
    viewport: { w: innerWidth, h: innerHeight },
    stage: { w: +st.width.toFixed(1), h: +st.height.toFixed(1) },
    ghost: gr ? {
      left: +gr.left.toFixed(1), right: +gr.right.toFixed(1),
      top: +gr.top.toFixed(1), bottom: +gr.bottom.toFixed(1),
      w: +gr.width.toFixed(1), h: +gr.height.toFixed(1),
      fontSize: cs.fontSize, letterSpacing: cs.letterSpacing,
      overflowLeft: +Math.max(0, -gr.left).toFixed(1),
      overflowRight: +Math.max(0, gr.right - innerWidth).toFixed(1),
      text: (g.textContent || '').trim(),
    } : null,
    sideIndex: sr ? {
      left: +sr.left.toFixed(1), right: +sr.right.toFixed(1),
      top: +sr.top.toFixed(1), bottom: +sr.bottom.toFixed(1),
      w: +sr.width.toFixed(1), h: +sr.height.toFixed(1),
    } : null,
    /* 三问的回答依据 */
    ghostOverflowPx: gr ? +((gr.width - st.width)).toFixed(1) : null,
    sideIndexAboveGhost: (sr && gr) ? sr.bottom <= gr.top : null,
    gapBetween: (sr && gr) ? +(gr.top - sr.bottom).toFixed(1) : null,
  };
})()`;

const data = await evalJS(MEASURE);

console.log(`=== 视口 ${W}x${H} ===`);
console.log(`  舞台 ${data.stage.w} × ${data.stage.h}`);
console.log('');
if (data.ghost) {
  const g = data.ghost;
  console.log(`描边大字 .ghost  "${g.text}"`);
  console.log(`  left=${g.left}  right=${g.right}  宽=${g.w}  高=${g.h}`);
  console.log(`  fontSize=${g.fontSize}  letterSpacing=${g.letterSpacing}`);
  console.log(`  左溢出=${g.overflowLeft}px   右溢出=${g.overflowRight}px`);
  console.log(`  超出舞台宽 ${data.ghostOverflowPx}px`);
  console.log('');
}
if (data.sideIndex) {
  const s = data.sideIndex;
  console.log(`SIDE INDEX .side-index`);
  console.log(`  left=${s.left}  right=${s.right}  top=${s.top}  bottom=${s.bottom}`);
  console.log(`  宽=${s.w}  高=${s.h}`);
  console.log('');
}
console.log('=== 三问判定 ===');
console.log(`  ① 需右移：当前 ghost 中心 = ${((data.ghost.left + data.ghost.right)/2).toFixed(1)}（视口中心 ${W/2}）`);
console.log(`     当前左右溢出 ${data.ghost.overflowLeft} / ${data.ghost.overflowRight} px`);
console.log(`  ② 是否完整显示：${data.ghost.overflowLeft === 0 && data.ghost.overflowRight === 0 ? '完整' : '不完整（有溢出）'}`);
console.log(`  ③ side-index 是否在 ghost 上方：${data.sideIndexAboveGhost}（间隙 ${data.gapBetween}px）`);

const report = { viewport: `${W}x${H}`, ...data };
writeFileSync(`${OUT}/ghost-geo-${W}x${H}.json`, JSON.stringify(report, null, 2));
console.log(`\n报告：${OUT}/ghost-geo-${W}x${H}.json`);
ws.close();
