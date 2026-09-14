// ── /works/ 轨道渲染（2026-09-14 i18n 时抽出为共享模块）───────────────────
//
// 这段逻辑此前内联在 src/pages/works.astro 的 <script> 里。i18n 要为英文版
// /en/works/ 加同一套交互，而复制一份会让它变成两处**必须手工同步**的
// 交互算法——2026-09-14 的白屏事故正是发生在这段代码上，它的正确性依赖
// 若干不显眼的细节（见下），绝不该有两个副本。
//
// 现在中英文两页各自只写：
//     import { mountWorksRail } from '../../lib/works-view.js';
//     mountWorksRail();
//
// ── 下面这些契约改之前必须读懂 ──────────────────────────────────────────
//
// ⚠️ **顺序敏感**：createWorksRail 会「同步」调用 onRender / getMax，所以它
//    依赖的所有 const 必须在调用之前初始化，否则 TDZ 抛 ReferenceError 会
//    中断整个模块 → 卡片停在 CSS 初始 opacity:0 → 白屏。
//    （dist 之所以看不出问题：esbuild 把常量折叠并提升函数声明，意外绕过了
//     TDZ。dev 不压缩，问题只在 dev 暴露。）
//
// ⚠️ **`max === 0` 绝不能短路 return**：卡片 CSS 初始 opacity:0 且靠 JS
//    点亮，早期测量若把 max 算成 0，短路会让内容永久不可见。max 为 0 时
//    按首屏停靠渲染（首组卡 0 强制可见），并由 works-rail.js 主动补测。
//
// ⚠️ **几何测量依赖 offsetLeft/offsetWidth**：.card-set 的 offsetParent 是
//    .stack-viewport（position:relative，为 .scroll-hint 的定位基准而设）。
//    rail 在 viewport 内 x=0 且两者均无 border/padding，相对 rail 测量与
//    相对 viewport 测量数值相等；transform 不影响布局值，每帧写 rail 位移
//    不会污染测量。改 rail/viewport 的盒模型时必须重新核对这条等价。
//
// ⚠️ **停靠点模型（2026-09-14 22:2x 定稿，回归 HEAD 0c7eb21 的步进节奏）**：
//    stops = [set0…setN, end]，**没有 intro 停靠**——首屏 = 组 0 居中、组内
//    卡 0 立即可见（「初始的第一张从左侧开始」）。end 测量 .endcard-face
//    （而非 .end-set，后者含 padding-left 会偏）。时间轴用**行程权重**
//    （times[j] = norm[j]/norm[end]）：组 k 到站 = times[k]，end = 1。
//
// ⚠️ **每段三拍节奏（用户 2026-09-14 22:15 文字规格，逐条对应）**：
//    段 [组k → 组k+1] = **飞入期(FLY) + 空转停顿(IDLE) + 过渡(其余)**：
//    1) 飞入期：组 k 钉在中心不动，组内卡 1..n 依次从右侧 80% 飞入扇形位
//       （「一个类型的卡片都滑动到中心」）；组 0 卡 0 首屏立即可见。
//    2) 空转停顿：飞入完成后一小段纯静止（「鼠标滚轮空转几个 px 实现
//       停顿的效果」）——滚轮继续转、画面不动，然后才启动下一组。
//    3) 过渡：组 k 整体左移出，组 k+1 **空白滑入**到中心（HEAD 语义：组
//       k+1 的卡在到站前 opacity 0，到站后才开始飞入）；最后一段滑向
//       「完」卡，progress=1 到底停止。
//    上滑倒放 = 同一确定函数反向执行（无内部状态、无一次性动画），这是
//    刻意的：renderCascade(pos, max) 对同一输入永远渲染同一画面。
//
// ⚠️ **渲染位移 = -origin - railPos**：origin = 组 0 的居中位移（负值，
//    首屏右移 |origin| 让组 0 居中）。⚠️ 2026-09-14 事故一：曾写成
//    `origin - railPos`，符号取反导致所有停靠点整体左偏 2|origin|——
//    回归锁 node qa/works-stops.mjs。
//
// ⚠️ **不能用 dom 选择器取 `.stack-card` 的兄弟 `.card-set` 之外的东西**：
//    geometry() 用 offsetLeft/offsetWidth 读几何，改 CSS 的定位会静默改变
//    里程——改 .stack-viewport / .stack-rail 定位前先读上面的等价说明。

import { createWorksRail } from './works-rail.js';

/** 飞入期占段程比例：组钉在中心，卡 1..n 依次飞入 */
const FLY = 0.5;
/** 空转停顿占段程比例：飞入完成后的纯静止区间（滚轮空转几下） */
const IDLE = 0.08;
/** 卡间错位（飞入轴）：卡 i 从飞入进度 i·STAG 开始起飞 */
const STAG = 0.25;
/** 单卡飞入窗口（飞入轴）：与 STAG 联合保证末卡在飞入期结束前完成 */
const FLY_WIN = 0.35;
/** 扇形层间阶梯（% 卡宽）与逐层缩小率 */
const CARD_GAP_DESKTOP = 10;
const CARD_GAP_MOBILE = 4;
const START_X_DESKTOP = 80;
const START_X_MOBILE = 40;
const SHRINK = 0.05;

/** 首屏提示文字淡出速度：progress 达 times[1] 的此比例时完全淡出 */
const HINT_FADE = 0.8;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
/** 两端减速的停靠缓动（输入须已 clamp 到 [0,1]） */
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * 挂载轨道交互。调用方页面必须提供以下 DOM 钩子：
 *   [data-stack-viewport]  视口容器（读 clientWidth 作居中基准）
 *   [data-stack-rail]      轨道（写 transform）
 *   [data-ruler] / [data-frame]  底部刻度尺（可选，传给 rail 做进度指示）
 *   [data-scroll-hint]     首屏提示文字（可选，随进度淡出）
 * 以及 `.card-set`（每组）与 `.end-set`（末端「完」卡）。
 */
export function mountWorksRail() {
  const viewport = document.querySelector('[data-stack-viewport]');
  const rail = document.querySelector('[data-stack-rail]');
  const rulerEl = document.querySelector('[data-ruler]');
  const frameEl = document.querySelector('[data-frame]');
  const hintEl = document.querySelector('[data-scroll-hint]');
  const total = Number(rail?.dataset.total ?? '0');

  /**
   * 轨道几何：停靠点序列 = 「让某个元素到达目标位置」所需的 rail 位移
   * （居中基准，可为负）：
   *   [0..n] —— 各 .card-set 居中（组 0 居中所需位移为负值 = 整体右移）
   *   [n+1]  —— 「完」的牌面 .endcard-face 居中（独立整体，单独到站）
   * 归一化（减组 0 项）后得到非负递增的 norm[]，进度 0/1 与首尾停靠点
   * 严格对齐；渲染位移 = -origin - railPos。
   */
  function geometry() {
    const sets = Array.from(document.querySelectorAll('.card-set'));
    const endSet = document.querySelector('.end-set');
    const vw = viewport.clientWidth;
    const raw = [];

    sets.forEach((el, i) => {
      const left = el.offsetLeft; // offsetParent = .stack-viewport，见文件头契约
      raw.push({ kind: 'set', idx: i, left, width: el.offsetWidth, center: left - (vw - el.offsetWidth) / 2 });
    });

    if (endSet) {
      const face = endSet.querySelector('.endcard-face') || endSet;
      const left = face.offsetLeft;
      const width = face.offsetWidth;
      raw.push({ kind: 'end', left, width, center: left - (vw - width) / 2 });
    }

    return { vw, raw };
  }

  function stackMax() {
    const { raw } = geometry();
    if (raw.length < 2) return 0;
    const origin = raw[0].center;
    return Math.max(0, raw[raw.length - 1].center - origin);
  }

  /**
   * 渲染一帧：轨道位移 + 卡片姿态 = progress 的确定函数（每段三拍：
   * 飞入 → 空转停顿 → 过渡，见文件头「每段三拍节奏」）。无内部状态、
   * 无一次性动画，同一 progress 永远渲染同一画面——上滑倒放可逆。
   */
  function renderCascade(pos, max) {
    // ⚠️ 不能用 `if (!max) return` 短路：max 为 0 时按首屏停靠渲染，
    // 首组卡 0 强制可见（见文件头契约）。
    const progress = max > 0 ? clamp(pos / max, 0, 1) : 0;

    const { vw, raw } = geometry();
    const cardSets = document.querySelectorAll('.card-set');
    const setCount = cardSets.length;
    const stopCount = raw.length;

    if (!setCount || stopCount < 2) {
      // 没有可停靠的内容：至少保证卡片以堆叠态可见，绝不白屏
      cardSets.forEach((set) => {
        set.querySelectorAll('.stack-card').forEach((card) => {
          card.style.opacity = '1';
          card.style.transform = 'translateX(0) translateY(0) scale(1)';
        });
      });
      if (hintEl) hintEl.style.opacity = '1';
      return;
    }

    const origin = raw[0].center; // 组 0 的居中位移（负值 = 右移）
    const norm = raw.map((s) => s.center - origin); // 非负递增
    const lastNorm = norm[stopCount - 1];
    const times = norm.map((v) => (lastNorm > 0 ? v / lastNorm : 0));

    // 当前所在段与段内进度：组 k 到站 = times[k]（无 intro 停靠）
    let segIdx = 0;
    while (segIdx < stopCount - 2 && progress > times[segIdx + 1]) segIdx++;
    const segLen = Math.max(times[segIdx + 1] - times[segIdx], 1e-4);
    const segProgress = clamp((progress - times[segIdx]) / segLen, 0, 1);

    // 轨道：飞入期 + 空转期钉在本段起点（组 k 保持居中），过渡期滑向下一站
    const goAt = FLY + IDLE;
    let railPos;
    if (segProgress <= goAt) {
      railPos = norm[segIdx];
    } else {
      const t = (segProgress - goAt) / (1 - goAt);
      railPos = norm[segIdx] + (norm[segIdx + 1] - norm[segIdx]) * smoothstep(t);
    }

    rail.style.transform = `translate3d(${-origin - railPos}px,0,0)`;

    // 首屏提示：progress 达 times[1]×HINT_FADE 前淡完；回滚自动恢复（纯函数）
    if (hintEl) {
      const t1 = Math.max(times[1] || 0, 1e-4);
      hintEl.style.opacity = String(clamp(1 - progress / (t1 * HINT_FADE), 0, 1));
    }

    // ── 卡片姿态（HEAD 0c7eb21 的飞入编排，绑到行程权重时间轴）──
    // 组 k 的飞入进度 flyP 只在飞入期 [0, FLY] 内增长；卡 i 从 i·STAG
    // 起飞、窗口内完成（窗口自适应 min(FLY_WIN, 1-i·STAG) 保证末卡恰好在
    // 飞入期结束前就位）。组 0 卡 0 例外：首屏立即可见。组 k>0 在到站前
    // 整组 opacity 0（过渡期空白滑入，到站后才飞入）——HEAD 语义。
    cardSets.forEach((set, setIdx) => {
      const cards = set.querySelectorAll('.stack-card');
      const n = cards.length;
      if (!n) return;

      const arrive = times[setIdx];
      const nextArrive = times[setIdx + 1] ?? 1;
      const seg = Math.max(nextArrive - arrive, 1e-4);
      const sp = clamp((progress - arrive) / seg, 0, 1);
      const flyP = clamp(sp / FLY, 0, 1);

      const isMobile = vw < 640;
      const cardGap = isMobile ? CARD_GAP_MOBILE : CARD_GAP_DESKTOP;
      const startX = isMobile ? START_X_MOBILE : START_X_DESKTOP;

      cards.forEach((card, i) => {
        // 第一组的第一张卡：立即显示
        const isImmediate = setIdx === 0 && i === 0;
        const win = Math.min(FLY_WIN, Math.max(1 - i * STAG, 1e-4));
        const reveal = isImmediate ? 1 : clamp((flyP - i * STAG) / win, 0, 1);
        const eased = 1 - Math.pow(1 - reveal, 3);

        // 飞入：x 从 startX 滑向扇形位 i*cardGap%
        const targetX = i * cardGap;
        const x = startX + (targetX - startX) * eased;
        const y = i * -2 * eased;
        const targetScale = 1 - (n - 1 - i) * SHRINK;
        const scale = 1 - (1 - targetScale) * eased;

        card.style.transform = `translateX(${x}%) translateY(${y}px) scale(${scale})`;
        card.style.opacity = String(reveal > 0 ? 1 : 0);
        card.style.zIndex = String(i + 1);
      });
    });
  }

  return viewport && rail
    ? createWorksRail({
        viewport,
        rail,
        frameEl,
        rulerEl,
        total,
        onRender: renderCascade,
        getMax: stackMax,
      })
    : null;
}
