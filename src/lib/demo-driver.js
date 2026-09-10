/* 指针驱动 —— 帧随动 + 卡片视差
 *
 * 设计原则：脚本只读 DOM。驱动哪个舞台、网格多大、多少帧，全部写在
 * [data-sprite-view] 的 data-* 属性里——新增/删除面板只需改页面，
 * 不需要碰这个文件。这里只留「怎么驱动」，不留「驱动谁」。
 *
 * 参数在构建时静态 import，不是运行时 fetch。早期版本用 fetch('motion.json')，
 * 在 file:// 下抛 TypeError，且位于 IIFE 最前面，会中断整个脚本；
 * 静态 import 后运行时零网络依赖，参数也享受打包器的路径校验。
 *
 * 图集元数据有两个来源，同源不同字段：
 *   src/data/*-meta.json   供构建时 import（精简字段 + 带前导斜杠的资源路径）
 *   public/motion/*.json   流水线原始产物（含 files[] 逐帧清单），运行时不需要
 *
 * 指针载荷：{ x, y, progress }
 *   x, y      指针在**舞台**内的归一化位置（0–1，已 clamp）→ 供卡片视差
 *   progress  帧随动进度（0–1）→ 锚点舞台的进度，向后兼容保留
 *
 * ── 几何归属：每个舞台各自一套（2026-09-10 起）──────────────────────────
 * 帧随动的坐标系是「指针相对**该舞台自己的**人物图片区域的方向角」。
 * 页面上同时存在多个人物（A/B 对比区）时，用同一个极点会让靠边的那一个
 * 看起来"没在看指针"——所以每个 [data-sprite-view] 各自缓存自己的
 * 人物矩形与可达角度区间，各自算 progress，互不干扰。
 * 视差仍旧只属于页面级：它要的是"指针在版面里的相对位置"，
 * 所以统一用**锚点舞台**的矩形归一化。
 *
 * 早前两者共用一个 x：舞台矩形归一化后又 clamp，于是指针移到视口四角时
 * x 被压到 0 或 1 —— (0,0) 永远播第 0 帧、右上角永远播末帧，且 y 维度完全丢失
 * （同一列的上下两点给出同一帧）。方向角的推导见 src/lib/pointer-frame.js。
 *
 * 人物图片区域矩形 = 立绘元素盒按**内容框**内缩，内缩量由 data-person-inset 给出
 * （左 上 右 下，四个 0–1 的分数，相对元素盒）。图集打包时按全部帧的墨迹并集
 * 裁切，四边各留透明垫；"区域内 = 首帧"要指的是人物图片的实际区域，
 * 所以这里收一次。数值来自各自 src/data/*-meta.json 的 contentBox。
 *
 * 象限可达角度区间（spans）在几何变化时预算一次，见 measure()。它不是可选优化：
 * 人物矩形底边贴视口底边时，"正下方"整条方向被死区占满，不归一化会让左下段首、
 * 右下段尾的帧永远取不到。
 */
import { createSpriteRenderer, createFrameAnimator } from '../lib/motion.js';
import { createCardParallax } from '../lib/parallax.js';
import { progressFromPointer, reachableSpans } from '../lib/pointer-frame.js';

const subscribers = [];
const state = { x: 0.5, y: 0.5, progress: 0 };
let queued = false;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* 指针事件一帧可能来很多次（高刷屏、高 DPI 鼠标），统一用 rAF 合帧，
   避免每张卡片、每个人物每次移动都写一遍 style。
   帧随动不订阅 state：它要的是**原始指针坐标**，不是舞台归一化后的值，
   所以这里单独存一份，由 applyProgress() 逐舞台现算。 */
const pointer = { x: 0, y: 0, active: false };

const flush = () => {
  queued = false;
  applyProgress();
  for (const fn of subscribers) fn(state);
};

const emit = (next) => {
  if (next.x !== undefined) state.x = clamp01(next.x);
  if (next.y !== undefined) state.y = clamp01(next.y);
  if (next.progress !== undefined) state.progress = clamp01(next.progress);
  if (!queued) {
    queued = true;
    requestAnimationFrame(flush);
  }
};

const readNumber = (value) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/* "左 上 右 下" 四个 0–1 的分数（相对元素盒）。写错就退回不内缩，
   宁可把透明垫算进去，也不要因为一个笔误让死区变成空集。 */
const readInsets = (value) => {
  const n = String(value ?? '').trim().split(/\s+/).map(Number);
  const ok = n.length === 4 && n.every((v) => Number.isFinite(v) && v >= 0 && v < 1);
  if (!ok) {
    if (value !== undefined) console.warn('[motion] data-person-inset 非法，已忽略：', value);
    return [0, 0, 0, 0];
  }
  return n;
};

/* 视口矩形 = 指针能到达的范围。帧随动的可达角度由它封顶，
   所以必须用视口而不是舞台——监听器挂在整个文档上。 */
const viewportRect = () => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

/* 帧序号读数：优先找舞台内的 [data-frame]，兼容旧版放在舞台父级里的写法 */
const findFrameLabel = (view) =>
  view.querySelector('[data-frame]') ?? view.parentElement?.querySelector('[data-frame]') ?? null;

/* 收集阶段：先把所有渲染器建好，再统一绑指针。
   否则「先绑 A、指针移到 B 时 B 的渲染器还没建」会出现短暂无声区。 */
const views = document.querySelectorAll('[data-sprite-view]');
const mounted = [];
let anchor = null; // 视差的归一化基准；默认第一个可驱动舞台

for (const view of views) {
  const target = view.querySelector('[data-sprite]');
  const asset = view.dataset.asset;
  const frameCount = readNumber(view.dataset.frameCount);
  const columns = readNumber(view.dataset.columns);
  const rows = readNumber(view.dataset.rows);

  if (!target || !asset || !frameCount || !columns || !rows) {
    console.warn('[motion] 舞台缺少必需属性，已跳过：', view.id || view);
    continue;
  }

  const renderer = createSpriteRenderer({
    target,
    frameLabel: findFrameLabel(view),
    asset,
    frameCount,
    columns,
    rows,
  });

  const animator = createFrameAnimator({
    frameCount,
    render: (frame) => renderer.render(frame),
  });

  const entry = {
    view,
    target,
    animator,
    insets: readInsets(view.dataset.personInset),
    personRect: null, // 本舞台自己的死区矩形
    spans: null, // 本舞台自己的象限可达角度
  };
  mounted.push(entry);

  // 视差锚点：显式标注 data-follow-anchor 的舞台优先，否则取第一个可驱动舞台
  if (!anchor || view.hasAttribute('data-follow-anchor')) anchor = entry;
}

/* 几何缓存。
   每次 pointermove 都调 getBoundingClientRect，会在「读几何 → 写 background-position」
   之间强制同步重排；改为在几何可能变化的时机失效重算。
   舞台矩形只给视差用；每个舞台的帧随动各用自己的人物图片区域矩形。 */
let stageRect = null;

/* 元素盒按"左 上 右 下"四个分数内缩，得到人物图片区域矩形 */
const insetRect = (box, [l, t, r, b]) => ({
  left: box.left + box.width * l,
  top: box.top + box.height * t,
  width: box.width * (1 - l - r),
  height: box.height * (1 - t - b),
});

const measure = () => {
  if (anchor) {
    const s = anchor.view.getBoundingClientRect();
    stageRect =
      s.width > 0 && s.height > 0
        ? { left: s.left, top: s.top, width: s.width, height: s.height }
        : null;
  }
  const page = viewportRect();
  for (const m of mounted) {
    const f = m.target.getBoundingClientRect();
    m.personRect =
      f.width > 0 && f.height > 0
        ? insetRect({ left: f.left, top: f.top, width: f.width, height: f.height }, m.insets)
        : null;
    // 象限可达角度只跟两个矩形有关，几何一变就重算（720 步 × 4 象限，代价可忽略）
    m.spans = m.personRect ? reachableSpans(m.personRect, page) : null;
  }
};

/* 逐舞台推进帧序号。舞台自己的矩形还没量到（display:none 等）时保持第 0 帧。 */
function applyProgress() {
  for (const m of mounted) {
    const p =
      pointer.active && m.personRect
        ? progressFromPointer({ x: pointer.x, y: pointer.y, rect: m.personRect, spans: m.spans })
        : 0;
    m.animator.setProgress(p);
    if (m === anchor) state.progress = p;
  }
}

if (anchor) {
  measure();
  // 字体/背景图落位后人物尺寸可能变，补测一次
  if (document.fonts?.ready) document.fonts.ready.then(measure);
  window.addEventListener('resize', measure, { passive: true });
  window.addEventListener('scroll', measure, { passive: true, capture: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(measure);
    for (const m of mounted) {
      ro.observe(m.view);
      ro.observe(m.target);
    }
  }
}

/* 指针作用域是整个文档，不是舞台盒子。
   人物矩形的方向角才是坐标系，舞台只决定视差的比例基准——
   指针在视口四角（舞台之外或被卡片压住的区域）时仍然应该跟随。 */
const handlePointer = (event) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.active = true;
  if (!stageRect) measure();
  if (!stageRect) return;
  emit({
    x: (event.clientX - stageRect.left) / stageRect.width,
    y: (event.clientY - stageRect.top) / stageRect.height,
  });
};

window.addEventListener('pointermove', handlePointer, { passive: true });
window.addEventListener('pointerdown', handlePointer, { passive: true });

/* 指针离开文档（鼠标移出窗口 / 切到别的 app）才归位：
   帧回到第 0 帧的正面姿态，视差回到中点（卡片无位移）。
   注意是 documentElement 的 pointerleave —— 只在指针离开视口时触发；
   挂在舞台上的话一移出舞台就触发，正是早前"移到页面角落不跟随"的来源。 */
document.documentElement.addEventListener('pointerleave', () => {
  pointer.active = false;
  emit({ x: 0.5, y: 0.5 });
});

/* 卡片视差：景深由页面的 data-depth 给出，脚本不假设版式几何 */
const cards = document.querySelectorAll('[data-depth]');
if (cards.length) {
  const parallax = createCardParallax({ cards: Array.from(cards) });
  subscribers.push((payload) => parallax.update(payload));
}

/* 全部就绪后广播一次，让所有订阅者从同一起点开始 */
emit({});
