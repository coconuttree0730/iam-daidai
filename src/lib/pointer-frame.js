/* 指针坐标 → 帧进度（纯函数，无 DOM）
 *
 * ── 交互契约 ────────────────────────────────────────────────────────────
 * 1) **人物图片区域矩形**内 → 第 0 帧（正面待机姿态）。矩形由立绘元素盒按内容框
 *    内缩得到（见 demo-driver.js 的 data-person-inset），所以指的是「人物图片的
 *    实际区域」，不是元素盒的透明垫。
 * 2) 矩形外，以矩形中心为极点按方向角分四象限，顺时针依次
 *      左下 → 左上 → 右上 → 右下
 *    对应帧序的四等分，左下段最前。
 * 3) 每个象限的**可用角度按该象限自身可达范围归一化**，铺满它那 1/4 帧序。
 *
 * ── 角度定义（屏幕坐标，y 轴向下）────────────────────────────────────────
 *   theta = atan2(dy, dx)          右 0° / 下 +90° / 左 ±180° / 上 −90°
 *   phi   = (theta − 90°) mod 360°  phi=0° 正下方；phi 增大即顺时针
 *
 *   phi =   0°  正下方  → 段位 0.000  ┐
 *   phi =  90°  正左方  → 段位 0.250  │ 顺时针
 *   phi = 180°  正上方  → 段位 0.500  │
 *   phi = 270°  正右方  → 段位 0.750  ┘
 *
 * 四象限的边界恰好是极点出发的四条半轴，所以「按方向角分四份」与「把页面按极点
 * 切成左下/左上/右上/右下四块」是同一件事，象限归属逐点一致。
 *
 * ── 为什么必须做第 3 步（可达范围归一化）────────────────────────────────
 * 只按 phi/360 线性映射时，每个象限「名义上」占 1/4 帧序，但**页面能提供的角度
 * 并不均匀**：极点离页面四边的距离悬殊时，某些象限的可达角度会被砍掉一大块。
 * 本项目就是这种情况——人物矩形底边贴着视口底边（实测 top=227.109 且
 * top+height=757=视口高），「正下方」整条方向被死区占满，于是接缝两侧的帧没有
 * 任何落点：实测左下只达 4.8–11.25、右下只达 33.75–40.2，**全片 46 帧有 10 帧
 * 永远播不到**，表现为「鼠标在左下区域动，人物几乎不变」（丢掉的那几帧恰好是
 * 头回正/抬头的转折）。归一化后每个象限都能取到本段的两个端点帧——
 * 这条性质由 qa/verify-sprite-follow.mjs 的覆盖率断言守住。
 *
 * ── 归一化后保留的性质 ─────────────────────────────────────────────────
 *   · 与距离无关 —— 只取方向。同方向无论远近都是同一帧，换屏幕尺寸不失效。
 *   · 象限内单调；四个段首尾相接，跨象限连续（90°/180°/270° 处两侧同帧）。
 *   · 首尾接缝是一个区间（死区底部那一段方向），不再是单根竖线——
 *     接缝两侧的帧因此都有落点，这正是修掉「某段端点取不到」的代价与收获。
 */

/** 象限顺序 = 顺时针，也是它们在帧序里的先后 */
export const QUADRANTS = ['BL', 'TL', 'TR', 'BR'];
const BASE_PHI = { BL: 0, TL: 90, TR: 180, BR: 270 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 矩形（DOMRect 或 {left,top,width,height}）内判定 —— 四边闭区间 */
export function containsPoint(rect, x, y) {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}

/** 方向角 phi ∈ [0,360)，0 = 正下方，增大即顺时针 */
export function phiOf(x, y, rect) {
  const dx = x - (rect.left + rect.width / 2);
  const dy = y - (rect.top + rect.height / 2);
  return ((((Math.atan2(dy, dx) * 180) / Math.PI - 90) % 360) + 360) % 360;
}

/** 象限标签；矩形内返回 'inside' */
export function quadrantFromPointer({ x, y, rect }) {
  if (!rect || containsPoint(rect, x, y)) return 'inside';
  const phi = phiOf(x, y, rect);
  return QUADRANTS[Math.floor(phi / 90)];
}

/** 射线 (ox,oy)+t·(dx,dy)（t ≥ 0）与轴对齐矩形的交区间；无交返回 null */
function rayHit(ox, oy, dx, dy, r) {
  let t0 = 0;
  let t1 = Infinity;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi; // 平行：在带内则不设限，带外则无交
    const a = (lo - o) / d;
    const b = (hi - o) / d;
    if (Math.min(a, b) > t0) t0 = Math.min(a, b);
    if (Math.max(a, b) < t1) t1 = Math.max(a, b);
    return true;
  };
  if (!slab(ox, dx, r.left, r.left + r.width)) return null;
  if (!slab(oy, dy, r.top, r.top + r.height)) return null;
  return t1 >= t0 ? [t0, t1] : null;
}

/** 页内射线上「死区之外」最长的一段长度；死区完全不吃该射线时等于整段 */
function outsideRun(inPage, inRect) {
  if (!inRect) return inPage[1] - inPage[0];
  return Math.max(inRect[0] - inPage[0], inPage[1] - inRect[1], 0);
}

/* 一个方向算「可达」所需的最小可用余量，取人物矩形长边的比例值。
   为什么需要它：死区按内容框内缩后，人物脚底与视口底边之间会留出一条
   透明垫高度（约 1.3%）的窄缝，"正下方"这条方向在几何上就变成可达了——
   但那条缝只有几个像素，指针停不稳，实际用不到。若不设阈值，四个象限都会
   被判成"已满 0–90°"，归一化被这条缝骗过去，接缝两侧的帧依旧实际取不到。
   取比例值而非固定像素：阈值与矩形同尺度，换视口尺寸（含 DPR）不漂移；
   而那条缝恰好也按同一比例缩放，所以两者不会此长彼消。 */
const MIN_RUN_RATIO = 0.02;

/** 沿方向 t（弧度）从极点出发，页内是否存在「够用」的死区外区域 */
function reachableDirection(cx, cy, theta, rect, page, minRun) {
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  const inPage = rayHit(cx, cy, dx, dy, page);
  if (!inPage) return false; // 该方向压根不在页面内
  return outsideRun(inPage, rayHit(cx, cy, dx, dy, rect)) >= minRun;
}

/**
 * 四个象限各自的可达角度区间，单位「该象限内的相对度」(0–90)。
 * 只在几何变化时调用一次，不在指针热路径上。
 *
 * @param {{left:number,top:number,width:number,height:number}} rect 人物矩形（死区）
 * @param {{left:number,top:number,width:number,height:number}} page 指针可活动范围（视口）
 * @param {number} steps 采样密度；720 → 0.125°
 */
export function reachableSpans(rect, page, steps = 720) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const minRun = Math.max(1, Math.max(rect.width, rect.height) * MIN_RUN_RATIO);
  const spans = {};
  for (const q of QUADRANTS) {
    let lo = null;
    let hi = null;
    for (let i = 0; i <= steps; i++) {
      const rel = (i / steps) * 90;
      const theta = ((BASE_PHI[q] + rel + 90) * Math.PI) / 180;
      if (!reachableDirection(cx, cy, theta, rect, page, minRun)) continue;
      if (lo === null) lo = rel;
      hi = rel;
    }
    // 整段都不可达（例如视口被压成一条线）时退回不做归一化
    spans[q] = lo === null ? [0, 90] : [lo, hi];
  }
  return spans;
}

/**
 * 指针坐标 → 归一化帧进度 ∈ [0,1]，供 createFrameAnimator.setProgress 消费。
 *
 * @param {{x:number,y:number,rect:object,spans?:object}} p
 *   spans 由 reachableSpans() 预先算好；缺省时退化为不做归一化的 rel/90。
 */
export function progressFromPointer({ x, y, rect, spans }) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return 0;
  if (containsPoint(rect, x, y)) return 0; // 契约 1：矩形内 = 第 0 帧

  const phi = phiOf(x, y, rect);
  const base = Math.floor(phi / 90) * 90;
  const rel = phi - base;
  const span = spans?.[QUADRANTS[base / 90]];
  const u =
    span && span[1] - span[0] > 1e-6
      ? clamp01((rel - span[0]) / (span[1] - span[0]))
      : rel / 90;
  return clamp01((base + u * 90) / 360);
}
