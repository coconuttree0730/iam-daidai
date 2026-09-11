/* 诊断 3：可见元素（大字/卡片/角标）随进度的位移向量
 *
 * 诊断 1 已证明背景层 translateY ≡ 0。
 * 诊断 2 的解析几何也表明背景渐变位置正确。
 * → 重新审视用户措辞：背景是近乎不可见的纸色 + 极淡白色提亮，
 *   用户**肉眼能看见的"背景"其实是版式元素**（描边大字、实心大字、
 *   卡片、角标）。若它们位移含 Y 分量，"斜向上"就成立了。
 *
 * 本脚本逐帧采集每个可见元素中心的**实际视口坐标**（getBoundingClientRect），
 * 计算相邻帧的位移向量 (dx, dy)，直接暴露"是否带垂直分量"。
 *
 * 用法： CDP_PORT=9350 node qa/diag-elem-vectors.mjs <URL> <outdir> <W> <H>
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

const PORT = process.env.CDP_PORT ?? '9350';
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

const CENTERS = `(() => {
  const pick = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { label, cx: +(r.left + r.width/2).toFixed(2), cy: +(r.top + r.height/2).toFixed(2),
             top: +r.top.toFixed(2), left: +r.left.toFixed(2) };
  };
  return {
    sc: Number(getComputedStyle(document.documentElement).getPropertyValue('--sc')) || 0,
    els: [
      pick('.stage-bg-shift', 'bg'),
      pick('.ghost', 'ghost'),
      pick('.title-en .w-left', 'PERSONAL'),
      pick('.title-en .w-right', 'ARCHIVE'),
      pick('.title-zh', 'zh-title'),
      pick('.mark-br .script', 'AboutMe'),
      pick('.fan .card:nth-child(1)', 'card01'),
      pick('.fan .card:nth-child(2)', 'card02'),
      pick('.fan .card:nth-child(3)', 'card03'),
      pick('.fan .card:nth-child(4)', 'card04'),
      pick('.infobar .group:first-child', 'bar-left'),
      pick('.infobar .group:last-child', 'bar-right'),
      pick('.hero-person', 'person'),
    ].filter(Boolean),
  };
})()`;

const samples = [];
samples.push(await evalJS(CENTERS));

const dispatchWheel = async (deltaY) => {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: Math.round(W / 2), y: Math.round(H / 2),
    deltaX: 0, deltaY, pointerType: 'mouse',
  });
};

for (let i = 1; i <= 10; i++) {
  for (let k = 0; k < 6; k++) await dispatchWheel(100);
  await sleep(600);
  samples.push(await evalJS(CENTERS));
  process.stdout.write(`  step ${String(i).padStart(2)}  sc=${samples[i].sc.toFixed(4)}\n`);
}

/* 计算每个元素从初始到最终的位移向量 */
const first = samples[0];
const last = samples[samples.length - 1];
const moves = [];
for (const e of first.els) {
  const l = last.els.find((x) => x.label === e.label);
  if (!l) continue;
  const dx = +(l.cx - e.cx).toFixed(1);
  const dy = +(l.cy - e.cy).toFixed(1);
  const angle = Math.abs(dy) > 0.5 ? Math.round(Math.atan2(dy, dx) * 180 / Math.PI) : null;
  moves.push({ label: e.label, dx, dy, driftAngleDeg: angle,
                driftRatio: dx !== 0 ? +(Math.abs(dy / dx)).toFixed(4) : null });
}

console.log('\n=== 各元素总位移向量（初始 → 最终）===');
console.log('  label'.padEnd(14) + 'dx'.padStart(10) + 'dy'.padStart(10) + '  |dy/dx|'.padStart(10));
for (const m of moves) {
  console.log(`  ${m.label.padEnd(12)}${String(m.dx).padStart(10)}${String(m.dy).padStart(10)}${String(m.driftRatio ?? '-').padStart(10)}`);
}

/* 判定：哪些元素带明显垂直漂移 */
const drifting = moves.filter((m) => Math.abs(m.dy) > 2 && m.label !== 'person');
console.log('\n=== 判定 ===');
if (drifting.length === 0) {
  console.log('  ✓ 没有任何可见元素带垂直漂移');
} else {
  for (const m of drifting) {
    console.log(`  ✗ ${m.label}: dy=${m.dy}px (dx=${m.dx}px) → 斜向 ${m.driftAngleDeg}°`);
  }
}

const report = { viewport: `${W}x${H}`, moves, drifted: drifting.map((d) => d.label) };
writeFileSync(`${OUT}/elem-vectors.json`, JSON.stringify(report, null, 2));
console.log(`\n报告：${OUT}/elem-vectors.json`);
ws.close();
process.exit(drifting.length ? 1 : 0);
