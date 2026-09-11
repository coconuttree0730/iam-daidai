/* 移动端触摸 scrub 回归测试（node qa/touch-scrub.mjs / npm run qa:touch）
 *
 * 为什么用 Node 桩 DOM 而不是无头浏览器：触摸 → 帧的映射全在 scroll-scrub.js 里，
 * 只依赖极少的 DOM 面（querySelector / dataset / addEventListener / rAF / fetch /
 * createImageBitmap）。用桩把它们覆盖掉，就能在 Node 里派发真实 touch 事件、
 * 让**真实处理代码**跑完，再从 dataset.currentFrame 读结果——秒级、确定性、
 * 零浏览器依赖（不产生 Chrome profile 残留）。
 *
 * 断言的是 2026-09-11 用户实测裁定后的期望语义：
 *   0 构造时 f0 已就绪（"f0 常备"，切入 scrub 才有画面）
 *   A 手指**上滑** = 前进（手机惯例：由下往上推动内容）
 *   B 一次全屏上滑应走完整段帧序（修"只能移动到一半"）
 *   C 下滑等距 = 倒退回 f0
 *   D 归零后交还 hero（scrub 标记清除）
 *   E 纵向上滑会 preventDefault（手势所有权在自己手里）
 *
 * 反向用例（改坏会红）：把 touchmove 里的 `input(-dy)` 改回 `input(dy)` → A/C 红；
 * 把触摸 RANGE_PX 系数改回 1.6 视口 → B 红（实测只能到 ~47%）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const manifest = JSON.parse(
  readFileSync(resolve(root, 'motion/scroll-slide/build/manifest.json'), 'utf8')
);

/* ── 桩 DOM ─────────────────────────────────────────────────────────── */
const listeners = new Map();
const rafQueue = [];
let rafSeq = 0;

const ctxStub = { clearRect() {}, drawImage() {} };
const sprite = { dataset: {}, hidden: true, style: {}, getContext: () => ctxStub };
const hero = { dataset: {}, hidden: false };
const view = {
  dataset: {
    scrubCount: String(manifest.frameCount),
    scrubCellWidth: String(manifest.cellWidth),
    scrubCellHeight: String(manifest.cellHeight),
    scrubSegments: JSON.stringify(manifest.segments),
  },
  querySelector: (sel) =>
    sel === '[data-scrub-sprite]' ? sprite : sel === '[data-sprite]' ? hero : null,
};

globalThis.document = {
  querySelector: (sel) => (sel === '[data-scrub-view]' ? view : null),
  documentElement: { dataset: {} },
};
globalThis.window = {
  innerHeight: 800,
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  matchMedia: (q) => ({ matches: /coarse/.test(q) }),
};
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return ++rafSeq;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });
globalThis.createImageBitmap = async () => ({ width: 966, height: 720, close() {} });
globalThis.Blob = class Blob {};

await import('../src/lib/scroll-scrub.js');

/* ── 事件派发与时间推进 ─────────────────────────────────────────────── */
const preventDefaults = [];
const fire = (type, touches) => {
  for (const fn of listeners.get(type) ?? []) {
    fn({ type, touches, preventDefault: () => preventDefaults.push(type) });
  }
};
let clock = 1000;
const settle = async (maxTicks = 400) => {
  let ticks = 0;
  while (rafQueue.length && ticks < maxTicks) {
    const cbs = rafQueue.splice(0);
    clock += 16.7;
    for (const cb of cbs) cb(clock);
    ticks++;
  }
  for (let i = 0; i < 2; i++) {
    // 解码落地后补画的微任务也要跑完
    await Promise.resolve();
  }
};
const frame = () => Number(sprite.dataset.currentFrame ?? -1);
const scrubbing = () => globalThis.document.documentElement.dataset.scrub === 'on';

/* 一次拖动：fromY → toY，分 steps 段派发 touchmove（含中间 rAF 推进） */
async function swipe(fromY, toY, steps = 30) {
  fire('touchstart', [{ clientX: 200, clientY: fromY }]);
  await settle();
  for (let i = 1; i <= steps; i++) {
    const y = fromY + ((toY - fromY) * i) / steps;
    fire('touchmove', [{ clientX: 200, clientY: y }]);
    await settle(60);
  }
  fire('touchend', []);
  await settle();
}

/* ── 断言 ───────────────────────────────────────────────────────────── */
const VIEWPORT = globalThis.window.innerHeight;
const SWIPE_PX = 600; // 一次自然滑动的手指数（≈0.75×视口高）
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

console.log(`视口高 ${VIEWPORT}px；滑动幅度 ${SWIPE_PX}px\n`);

// 基线：构造时应已解码 seg0 并画出 f0（"f0 常备"，切入 scrub 才有画面）
await settle();
console.log('基线：起始帧 =', frame(), '| scrub 未激活 =', !scrubbing());
check('0 构造时 f0 已就绪', frame() === 0, `起始帧号 ${frame()}`);

// A + B：一次上滑（y 大 → y 小）应推进到末帧
await swipe(760, 760 - SWIPE_PX);
const upFrame = frame();
check('A 手指上滑 = 前进（越过首帧）', upFrame > 0, `上滑后帧号 ${upFrame}`);
check(
  'B 一次全屏上滑走完帧序',
  upFrame >= manifest.frameCount - 1,
  `上滑后帧号 ${upFrame} / 期望 ${manifest.frameCount - 1}`
);

// C：下滑等距应回到 f0 并退出 scrub
await swipe(120, 120 + SWIPE_PX);
const backFrame = frame();
check('C 下滑 = 倒退回 f0', backFrame === 0, `下滑后帧号 ${backFrame}`);
check('D 归零后交还 hero（scrub 关闭）', !scrubbing(), `scrub 标记 = ${scrubbing()}`);

// E：静止姿态下上滑应当激活
check('E 上滑能激活 scrub 模式', preventDefaults.length > 0, `preventDefault 触发 ${preventDefaults.length} 次`);

/* ── 报告 ───────────────────────────────────────────────────────────── */
console.log('\n结果：');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  —— ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
