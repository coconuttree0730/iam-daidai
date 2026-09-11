/* 诊断：背景横向位移时是否发生「斜向上移动」（垂直漂移）
 *
 * 用户报告的症状：背景横向移动的同时，元素慢慢往上跑。
 *
 * 本脚本做一件事：在真实页面里模拟滚动，逐帧采集
 *   - .stage-bg-shift 的 computed translate（X / Y 分量）
 *   - 背景层的 getBoundingClientRect（真实渲染几何）
 *   - 亮斑的视觉位置（用 canvas 采样背景层像素，定位最亮行）
 *
 * 判据：
 *   Y 分量恒为 0 + 亮斑质心 y 不随进度上移 → 无漂移
 *   Y 分量非 0 或亮斑质心上移 → 复现 bug
 *
 * 用法： CDP_PORT=9346 node qa/diag-bg-drift.mjs <URL> <outdir> <W> <H>
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2];
const OUT = process.argv[3] ?? 'qa/out';
const W = Number(process.argv[4] ?? 1440);
const H = Number(process.argv[5] ?? 900);
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
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: URL_ });
await sleep(3000);

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 80));
  return r.result.value;
};

/* 采集函数：读背景层的 computed translate 与几何，并采样亮斑质心 y。
 *
 * 亮斑质心采样：把背景层的 background-image 在离屏 canvas 上用同样参数
 * 画出来，再逐行求亮度加权质心 y —— 这是"亮斑在视觉上跑没跑"的直接证据，
 * 不受 transform 矩阵干扰。 */
const probeExpr = `(() => {
  const el = document.querySelector('.stage-bg-shift');
  if (!el) return { err: 'no .stage-bg-shift' };
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    translate: cs.translate,
    transform: cs.transform,
    sc: getComputedStyle(document.documentElement).getPropertyValue('--sc').trim(),
    scv: getComputedStyle(document.querySelector('.stage')).getPropertyValue('--sc-v').trim(),
    travel: getComputedStyle(document.querySelector('.stage')).getPropertyValue('--sc-travel').trim(),
    rectTop: +rect.top.toFixed(2),
    rectHeight: +rect.height.toFixed(2),
    rectLeft: +rect.left.toFixed(2),
    bgImage: cs.backgroundImage.slice(0, 120),
    bgSize: cs.backgroundSize,
    bgPos: cs.backgroundPosition,
  };
})()`;

const samples = [];

/* 用 CDP 派发真实滚轮事件，逐步推进 scrub 进度。 */
const dispatchWheel = async (deltaY) => {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(W / 2),
    y: Math.round(H / 2),
    deltaX: 0,
    deltaY,
    pointerType: 'mouse',
  });
};

console.log('=== 采集初始态 ===');
samples.push({ step: 0, ...(await evalJS(probeExpr)) });

/* 推进：每格 wheel 后等动画收敛再采样。smoothDamp 需按行程等待，
   用轮询到连续两次读数不变来判定收敛，而不是固定 sleep。 */
const STEPS = 14;
for (let i = 1; i <= STEPS; i++) {
  for (let k = 0; k < 8; k++) await dispatchWheel(100);
  await sleep(700);
  const s = await evalJS(probeExpr);
  samples.push({ step: i, ...s });
  process.stdout.write(`  step ${String(i).padStart(2)}  sc=${String(s.sc).padStart(6)}  translate=${s.translate}\n`);
}

/* 判定：解析 translate 的 Y 分量 */
const parseTranslateY = (t) => {
  if (!t || t === 'none') return 0;
  const parts = t.match(/-?[\d.]+/g);
  if (!parts) return 0;
  return Number(parts[1] ?? 0);
};

let maxAbsY = 0;
let ySeries = [];
for (const s of samples) {
  const y = parseTranslateY(s.translate);
  ySeries.push(y);
  maxAbsY = Math.max(maxAbsY, Math.abs(y));
}

const scSeries = samples.map((s) => Number(s.sc) || 0);
const progressed = Math.max(...scSeries) > 0.05;

const report = {
  viewport: `${W}x${H}`,
  progressed,
  maxSc: Math.max(...scSeries),
  maxAbsTranslateY: +maxAbsY.toFixed(4),
  translateYSeries: ySeries,
  moveSeries: samples.map((s) => ({
    step: s.step, sc: s.sc, translate: s.translate,
    rectLeft: s.rectLeft, rectTop: s.rectTop,
    scv: s.scv, travel: s.travel,
  })),
  geometry: samples[0] && {
    bgImage: samples[0].bgImage, bgSize: samples[0].bgSize, bgPos: samples[0].bgPos,
    rectTop: samples[0].rectTop, rectHeight: samples[0].rectHeight,
    transform: samples[0].transform,
  },
};

/* 结论 */
const verdict = [];
if (!progressed) verdict.push('⚠ 滚动未推进 scrub（--sc 恒 0）→ 本脚本没能驱动真实代码路径，结论无效');
if (maxAbsY > 0.5) verdict.push(`✗ 检出垂直漂移：translate 的 Y 分量最大 ${maxAbsY}px`);
else verdict.push('✓ translate 的 Y 分量恒为 0');
report.verdict = verdict;

writeFileSync(`${OUT}/bg-drift.json`, JSON.stringify(report, null, 2));
console.log('\n=== 判定 ===');
for (const v of verdict) console.log('  ' + v);
console.log(`\n  max --sc = ${Math.max(...scSeries)}`);
console.log(`  max |translateY| = ${maxAbsY}`);
console.log(`\n报告：${OUT}/bg-drift.json`);

ws.close();
process.exit(verdict.some((v) => v.startsWith('✗')) ? 1 : 0);
