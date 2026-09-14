// ── /works/ 轨道渲染（2026-09-14 i18n 时抽出为共享模块）───────────────────
//
// 这段逻辑此前内联在 src/pages/works.astro 的 <script> 里。i18n 要为英文版
// /en/works/ 加同一套交互，而复制一份会让它变成两处**必须手工同步**的
// 动画算法——2026-09-14 的白屏事故正是发生在这段代码上，它的正确性依赖
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
//    （dist 之所以看不出问题：esbuild 把 `1 - TRANS` 常量折叠成 0.7 并提升
//     函数声明，意外绕过了 TDZ。dev 不压缩，问题只在 dev 暴露。）
//
// ⚠️ **`max === 0` 绝不能短路 return**：卡片 CSS 初始 opacity:0 且靠 JS
//    点亮，早期测量若把 max 算成 0，短路会让内容永久不可见。max 为 0 时
//    按首屏停靠渲染（卡片强制可见），并由 works-rail.js 主动补测。
//
// ⚠️ **几何测量依赖 offsetLeft/offsetWidth**：.card-set 的 offsetParent 是
//    .stack-viewport（position:relative，为 .scroll-hint 的定位基准而设）。
//    rail 在 viewport 内 x=0 且两者均无 border/padding，相对 rail 测量与
//    相对 viewport 测量数值相等；transform 不影响布局值，每帧写 rail 位移
//    不会污染测量。改 rail/viewport 的盒模型时必须重新核对这条等价。
//
// ⚠️ **停靠点模型（2026-09-14 晚改版）**：stops = [intro, set0…setN, end]。
//    intro = 首屏停靠（首卡右缘贴视口右缘，负位移=整体右移）；end 测量
//    .endcard-face（而非 .end-set，后者含 padding-left 会偏）。时间轴用
//    **行程权重**（times[j] = norm[j]/norm[end]），段程与滚动量线性对应，
//    不再等分——等分 + 不均行程曾导致拆叠动画窗口与组进出场错位。
//
// ⚠️ **卡片可见性模型（2026-09-14 深夜按用户裁定回退到 HEAD 手感）**：
//    组 k>0 到站前整组隐藏（opacity 0、停在视口右侧 80% 处），到站后在停留
//    期内逐张飞入堆叠成扇；组 0 从 intro 起就以堆叠态可见。「渐入显得拖沓」
//    的旧反馈针对的是过长的透明度过渡，不是飞入本身；嫌慢调 stagger/0.35，
//    不要改回「原地摊开」——那正是「折叠卡片形态消失」事故的次因。
//
// ⚠️ **不能用 dom 选择器取 `.stack-card` 的兄弟 `.card-set` 之外的东西**：
//    geometry() 用 offsetLeft/offsetWidth 读几何，改 CSS 的定位会静默改变
//    里程——改 .stack-viewport / .stack-rail 定位前先读上面的等价说明。

import { createWorksRail } from './works-rail.js';

/** 段间过渡占每段的尾部比例 */
const TRANS = 0.3;

/** 首屏停靠：首卡右缘距视口右缘的距离（桌面；移动端取 24px 保seg0不退化） */
const INTRO_RIGHT_PAD = 40;
/** 首屏提示文字淡出速度：progress 达 times[1] 的此比例时完全淡出 */
const HINT_FADE = 0.8;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

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
   * （居中基准，未归一化，可为负）：
 *   [0] intro —— 首卡右缘距视口右缘 INTRO_RIGHT_PAD（首屏，负值=右移）
 *   [1..n]    —— 各 .card-set 居中
 *   [n+1] end —— 「完」的牌面 .endcard-face 居中
 * 归一化（减 intro 项）后得到非负递增的 norm[]，进度 0/1 与首尾停靠点
 * 严格对齐；渲染位移 = -origin - railPos（intro 位移减已行驶程）。
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

    // intro 停靠点：让首卡右缘贴近视口右缘。移动端用小边距（24px），
    // 保证 intro.center < set0.center（seg0 行程不为 0，时间轴不退化）。
    if (raw.length) {
      const first = raw[0];
      const rightPad = vw < 640 ? 24 : INTRO_RIGHT_PAD;
      raw.unshift({ kind: 'intro', left: first.left, width: first.width, center: first.left - (vw - first.width - rightPad) });
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
   * 横向卡牌堆叠展开
   *
   * 时间轴（行程权重）：times[j] = norm[j] / norm[end]。seg0（intro→set0）
   * 全程过渡；其余段「停留(1-TRANS) + 过渡(TRANS)」。
   *
   * 组 k 的动画窗口：winStart = 组 k 开始进入视口（seg k 过渡期起点），
   * winEnd = 组 k 居中后停留期的一半。窗口内组以堆叠态进入、居中时展开。
   */
  function renderCascade(pos, max) {
    // ⚠️ 不能用 `if (!max) return` 短路：max 为 0 时按首屏停靠渲染，
    // 卡片强制可见（见文件头契约）。
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

    const origin = raw[0].center; // intro（负值）
    const norm = raw.map((s) => s.center - origin); // 非负递增
    const lastNorm = norm[stopCount - 1];
    const times = norm.map((v) => (lastNorm > 0 ? v / lastNorm : 0));

    // 当前所在段与段内进度
    let segIdx = 0;
    while (segIdx < stopCount - 2 && progress > times[segIdx + 1]) segIdx++;
    const segLen = times[segIdx + 1] - times[segIdx];
    const segProgress = segLen > 0 ? clamp((progress - times[segIdx]) / segLen, 0, 1) : 1;

    // 段内插值：seg0 全程 smoothstep；其余段「停留 → 过渡」
    let railPos;
    if (segIdx === 0) {
      const eased = segProgress * segProgress * (3 - 2 * segProgress);
      railPos = norm[0] + (norm[1] - norm[0]) * eased;
    } else if (segProgress > 1 - TRANS) {
      const t = (segProgress - (1 - TRANS)) / TRANS;
      const eased = t * t * (3 - 2 * t);
      railPos = norm[segIdx] + (norm[segIdx + 1] - norm[segIdx]) * eased;
    } else {
      railPos = norm[segIdx];
    }

    // 移动轨道：intro 停靠的位移是 -origin（正值：整体右移，首卡右缘贴视口右
    // 缘），之后随已行驶程 railPos 递减。⚠️ 2026-09-14 事故：曾写成
    // `origin - railPos`，符号取反导致所有停靠点整体左偏 2|origin|
    // （vw=1280 时 755px）——没有任何一组真正居中、扇形展开全在屏外、
    // 「完」卡永远到不了屏内。回归锁：node qa/works-stops.mjs（A1/A2/A4）。
    rail.style.transform = `translate3d(${-origin - railPos}px,0,0)`;

    // 首屏提示：seg0 走到 HINT_FADE 比例前淡完；回滚自动恢复（纯函数）
    if (hintEl) {
      const t1 = Math.max(times[1] || 0, 1e-4);
      hintEl.style.opacity = String(clamp(1 - progress / (t1 * HINT_FADE), 0, 1));
    }

    // ── 动画卡片 ──
    // 手感以 HEAD 0c7eb21 为准（用户 2026-09-14 裁定回退）：组到站前整组隐藏，
    // 到站后的停留期内逐张从右侧飞入、堆叠成扇（x: 80% → i*cardGap%）；
    // 组 0 例外——从 intro 首屏起就以堆叠态可见（首屏 = 封面贴右 + 滚动提示），
    // 到站后从 x=0 就位展开（不跳变）。末卡在停留期 ~0.71 处就位
    //（appearAt 0.36 + reveal 窗 0.35），与 HEAD 的节奏一致。
    cardSets.forEach((set, setIdx) => {
      const cards = set.querySelectorAll('.stack-card');
      const cardCount = cards.length;
      if (!cardCount) return;

      // 组 k 的飞入窗口：arrive = 组 k 到站（stops 里组 k 在位置 k+1），
      // stay = 该停靠的停留期全长（下一段的前 1-TRANS）。
      const arrive = times[setIdx + 1];
      const stay = (1 - TRANS) * (times[setIdx + 2] - times[setIdx + 1]);
      const sp = clamp((progress - arrive) / Math.max(stay, 1e-4), 0, 1);

      // 末卡也要能在停留期内完全展开（固定 0.18 + 多卡时会溢出窗口）
      const stagger = Math.min(0.18, 0.65 / Math.max(1, cardCount - 1));

      const isMobile = vw < 640;
      const cardGap = isMobile ? 4 : 10; // 百分比（相对卡宽），保持原扇形阶梯
      const startX = setIdx === 0 ? 0 : (isMobile ? 40 : 80);

      cards.forEach((card, i) => {
        const appearAt = i * stagger;
        const reveal = clamp((sp - appearAt) / 0.35, 0, 1);
        const eased = 1 - Math.pow(1 - reveal, 3);

        // 飞入：x 从 startX 滑向扇形位 i*cardGap%
        const targetX = i * cardGap;
        const x = startX + (targetX - startX) * eased;
        const y = i * -2 * eased;

        const shrinkRate = 0.05;
        const targetScale = 1 - (cardCount - 1 - i) * shrinkRate;
        const scale = 1 - (1 - targetScale) * eased;

        card.style.transform = `translateX(${x}%) translateY(${y}px) scale(${scale})`;
        card.style.opacity = setIdx === 0 ? '1' : reveal > 0 ? '1' : '0';
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
