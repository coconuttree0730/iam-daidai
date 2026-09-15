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
// ⚠️ **停靠点模型（2026-09-15 v3：加 intro 首站，用户微调）**：
//    stops = [intro, set0…setN, end, endFly]。intro = 初始态：首卡中心钉在
//    视口右缘（恰好露出左半边，「滚动查看作品」提示居于左侧空白区中点）；
//    组 0 停靠 = 卡片滑到正中（居中位移即旧 v2 的 raw[0]）。endFly 是
//    **虚拟末站**：在 end 的居中位移之外再延「一卡宽 + 20% 视口」，只用来
//    把 progress=1 顶到「完」卡飞入完成的瞬间；轨道在 [end → endFly] 段
//    钉在 end 站不动，这段行程全部被「完」卡的飞入期消耗。时间轴用
//    **行程权重**（times[j] = norm[j]/norm[endFly]）；**raw 与 times 从 v2
//    起整体右移一位**：组 k 到站 = times[k+1]、下一段到站 = times[k+2]。
//    首段 [intro → 组0] 无三拍（无卡可飞入），滚动全程平滑滑动到正中；
//    且滚动消耗按 INTRO_BUDGET 压缩（2026-09-15 用户裁定「一圈滚轮才到，太慢」，
//    见常量注释——max 是滚动空间而非轨道里程，pos→progress 分段换算）。
//
// ⚠️ **「完」卡播放形式与其他组同构（2026-09-15，用户裁定「做成卡片」）**：
//    此前它是一张 ~216px 的小卡、全程可见（用户观感「固定在页面上」），
//    且居中这张小卡只能把最后一张作品卡推出一半——末端状态永远有半张
//    旧卡赖在屏上。现在改为与其他组同一套三拍：最后一段过渡时空白滑入
//    （opacity 0），到站后钉在中心、消费末段飞入期从右侧飞入（同组内
//    卡 0 的节奏），progress=1 恰好飞入完成。纯函数，上滑倒放可逆。
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

/**
 * 首段滚动预算（2026-09-15 用户裁定「一圈滚轮才到屏心，太慢」）：
 * intro 段的轨道里程恰为半视口宽，原先按里程全额计费滚轮；现在只收
 * 里程 × 此比例——与普通段过渡期（1 - FLY - IDLE）的滚动密度一致，
 * 约半圈滚轮到站。max 与 progress 的分段换算在 stackMax / renderCascade，
 * 两处消费同一份几何公式，改一处必改另一处。
 */
const INTRO_BUDGET = 0.42;

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
   *   [0]      —— intro：首卡中心钉在视口右缘（露左半边），v3 用户微调
   *   [1..n+1] —— 各 .card-set 居中
   *   [n+2]    —— 「完」的牌面居中（测量 .endcard 包裹层，见下）
   *   [n+3]    —— 虚拟末站 endFly：位移多延一卡宽 + 20% 视口，轨道不停，
   *               只为把 progress=1 顶到「完」卡飞入完成（见文件头模型 v3）
   * 归一化（减 intro 项）后得到非负递增的 norm[]，进度 0/1 与首尾停靠点
   * 严格对齐；渲染位移 = -origin - railPos。
   */
  function geometry() {
    const sets = Array.from(document.querySelectorAll('.card-set'));
    const endSet = document.querySelector('.end-set');
    const vw = viewport.clientWidth;
    const raw = [];

    // intro 停靠：要让首卡中心落在视口右缘，需 translate = vw - left - w/2，
    // 停靠值取其相反数（与 .card-set 的 center 同一约定）。
    const firstSet = sets[0];
    if (firstSet) {
      const left = firstSet.offsetLeft;
      const width = firstSet.offsetWidth;
      raw.push({ kind: 'intro', left, width, center: left + width / 2 - vw });
    }

    sets.forEach((el, i) => {
      const left = el.offsetLeft; // offsetParent = .stack-viewport，见文件头契约
      raw.push({ kind: 'set', idx: i, left, width: el.offsetWidth, center: left - (vw - el.offsetWidth) / 2 });
    });

    if (endSet) {
      // ⚠️ 测量对象是 .endcard（<a> 包裹层）而非 .endcard-face：offsetLeft 的
      // 参照物 = 最近「包含块」祖先，而 will-change:transform / position 都会
      // 成为包含块（Chrome 128 起 offsetParent 沿包含块链走）。face 的直接
      // 父层 .endcard 带 will-change——若测 face，参照物变成 .endcard，读数
      // ≈0，「完」卡停靠点塌到原点、times 全盘错乱（2026-09-15 事故：第二组
      // 永远到不了站）。.endcard 自身的 offsetParent 稳定是 .stack-rail，
      // 与 .card-set 同一坐标系；它恰好完整包裹 face，几何等价。
      const face = endSet.querySelector('.endcard') || endSet.querySelector('.endcard-face') || endSet;
      const left = face.offsetLeft;
      const width = face.offsetWidth;
      const endCenter = left - (vw - width) / 2;
      raw.push({ kind: 'end', left, width, center: endCenter });
      // 虚拟末站：飞入期行程预算 = 一卡宽 + 20% 视口（与普通段的滚轮
      // 消耗量同量级），不对应任何真实位移——renderCascade 在此段钉住轨道。
      raw.push({ kind: 'endFly', left, width, center: endCenter + width + vw * 0.2 });
    }

    return { vw, raw };
  }

  function stackMax() {
    const { raw } = geometry();
    if (raw.length < 2) return 0;
    const origin = raw[0].center;
    const railMax = Math.max(0, raw[raw.length - 1].center - origin);
    // 首段预算压缩：intro 段只消费其轨道里程 × INTRO_BUDGET 的滚动量，
    // 返回值 = 滚动空间总里程（≠ 轨道里程 railMax）；换算契约见常量注释。
    const introRail = Math.max(0, raw[1].center - origin);
    return Math.max(0, railMax - introRail * (1 - INTRO_BUDGET));
  }

  /**
   * 渲染一帧：轨道位移 + 卡片姿态 = progress 的确定函数（每段三拍：
   * 飞入 → 空转停顿 → 过渡，见文件头「每段三拍节奏」）。无内部状态、
   * 无一次性动画，同一 progress 永远渲染同一画面——上滑倒放可逆。
   */
  function renderCascade(pos, max) {
    // ⚠️ 不能用 `if (!max) return` 短路：max 为 0 时按首屏停靠渲染，
    // 首组卡 0 强制可见（见文件头契约）。
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

    const origin = raw[0].center; // intro 停靠位移（v3：初始态首卡半出右屏）
    const norm = raw.map((s) => s.center - origin); // 非负递增
    const lastNorm = norm[stopCount - 1];
    const times = norm.map((v) => (lastNorm > 0 ? v / lastNorm : 0));

    // 进度换算（首段预算压缩，2026-09-15）：pos 不再全程 1:1 兑换 progress。
    // 首段 [0, introScroll] 兑换 0 → times[1]；此后 times[1] → 1 线性，且
    // 剩余滚动空间恰等于剩余轨道里程（stackMax 已扣除首段折扣，两式相减
    // 可验证），普通段的滚动密度与压缩前逐 px 一致。
    const introRail = norm[1];
    const introScroll = introRail * INTRO_BUDGET;
    let progress = 0;
    if (max > 0) {
      progress = pos <= introScroll
        ? times[1] * (introScroll > 0 ? clamp(pos / introScroll, 0, 1) : 1)
        : times[1] + clamp((pos - introScroll) / Math.max(max - introScroll, 1e-4), 0, 1) * (1 - times[1]);
      progress = clamp(progress, 0, 1);
    }

    // 当前所在段与段内进度：组 k 到站 = times[k+1]（raw[0] 是 intro，v3 起右移一位）
    let segIdx = 0;
    while (segIdx < stopCount - 2 && progress > times[segIdx + 1]) segIdx++;
    const segLen = Math.max(times[segIdx + 1] - times[segIdx], 1e-4);
    const segProgress = clamp((progress - times[segIdx]) / segLen, 0, 1);

    // 轨道：飞入期 + 空转期钉在本段起点（组 k 保持居中），过渡期滑向下一站。
    // 例外一：首段 [intro → 组0] 无卡可飞入，滚动全程平滑滑到正中（无空转死区）。
    // 例外二：末段 [end → endFly] 的下一站是虚拟站，轨道整段钉在 end（「完」
    // 卡居中位）不动，行程全部让给「完」卡的飞入期。
    const goAt = FLY + IDLE;
    const nextStop = raw[segIdx + 1];
    let railPos;
    if (raw[segIdx].kind === 'intro') {
      railPos = norm[segIdx] + (norm[segIdx + 1] - norm[segIdx]) * smoothstep(segProgress);
    } else if (segProgress <= goAt || nextStop.kind === 'endFly') {
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

      const arrive = times[setIdx + 1];      // v3：raw[0] 是 intro，整体右移一位
      const nextArrive = times[setIdx + 2] ?? 1;
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

    // ── 「完」卡（与其他组同构的三拍，2026-09-15）──
    // 到站 times[end] 前随轨道空白滑入（opacity 0）；到站后轨道钉在 end 站，
    // 「完」卡消费末段 [end → endFly] 的飞入期从右侧 80% 飞入（同组内卡 0
    // 的节奏：STAG=0、窗口 FLY_WIN），progress=1 恰好飞入完成。写在
    // .endcard（<a>）上，不碰 .endcard-face——后者留着做 hover 的 rotate。
    const endStop = raw[stopCount - 2];
    const endFlyStop = raw[stopCount - 1];
    const endcardEl = document.querySelector('.end-set .endcard');
    if (endcardEl && endStop?.kind === 'end' && endFlyStop?.kind === 'endFly') {
      const arrive = times[stopCount - 2];
      const seg = Math.max(1 - arrive, 1e-4);
      const sp = clamp((progress - arrive) / seg, 0, 1);
      const flyP = clamp(sp / FLY, 0, 1);
      const win = Math.min(FLY_WIN, 1);
      const reveal = clamp(flyP / win, 0, 1);
      const eased = 1 - Math.pow(1 - reveal, 3);
      const isMobile = vw < 640;
      const startX = isMobile ? START_X_MOBILE : START_X_DESKTOP;
      endcardEl.style.transform = `translateX(${startX * (1 - eased)}%)`;
      endcardEl.style.opacity = String(reveal > 0 ? 1 : 0);
    }
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
