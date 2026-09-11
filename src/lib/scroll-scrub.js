/* 滚动 scrub —— hero 单屏原地融合（2026-09-11 用户裁定）
 *
 * 页面不滚动（hero 单屏、黑条页脚恒定）。纵向滚轮/触摸输入被截获为
 * scrub 进度，人物 canvas 在两套素材间"原地换血"：
 *
 *   pointer 模式（默认）→ hero 121 帧指针跟随（demo-driver）；
 *     向下滚动累计 ≥ ENTER_PX → 切入 scroll 模式（193 帧线性钳制素材）。
 *     切入瞬间两素材都是"正面静止"姿态且墨迹同尺度同位（f0 对齐校准，
 *     见 index.astro 的 .scroll-figure）→ 观感是素材原地换血，人物没动。
 *   scroll 模式 → 滚轮/触摸增量直接映射进度（下=前进，上=倒退，两端钳制）；
 *     倒回 f0 → 自动切回 pointer 模式。
 *
 * 与 demo-driver 的互斥：scroll 模式期间在 documentElement 上置
 * data-scrub="on"，demo-driver 的 applyProgress 看到它就冻结 hero 姿态——
 * 指针移动不再驱动（两素材不是连续动作，指针映射此刻无意义）。
 *
 * 加载预算：不做全量预热。构造时的首次 render(0) 会顺带拉取并解码 seg0
 * （366KB），f0 常备；其余 19 段在 scrub 推进时按需取（两层缓存），
 * 越往后段越提前就位——单屏页没有"预热窗口"，按需是唯一合理策略。
 */
import {
  createFrameAnimator,
  createSegmentedSpriteRenderer,
} from './motion.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const readNumber = (value) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const view = document.querySelector('[data-scrub-view]');

if (view) {
  const sprite = view.querySelector('[data-scrub-sprite]');
  const heroSprite = view.querySelector('[data-sprite]');
  const frameCount = readNumber(view.dataset.scrubCount);
  const cellWidth = readNumber(view.dataset.scrubCellWidth);
  const cellHeight = readNumber(view.dataset.scrubCellHeight);
  let segments = null;
  try {
    segments = JSON.parse(view.dataset.scrubSegments ?? '');
  } catch {
    segments = null;
  }

  if (sprite && heroSprite && frameCount && cellWidth && cellHeight && segments) {
    /* 手感参数：ENTER_PX = 进入阈值（防误触）；RANGE_PX = 满行程的累计纵向位移。
       桌面向下滚轮按 deltaY 原样累计（~100px/格，2400px ≈ 24 格走完 193 帧）。
       触摸（pointer: coarse）本地行程只有一屏多，沿用 2400px 要划三屏多，
       所以按 1.6×视口高折算并 clamp 到 [900, 1600]——一次全屏滑动约走 60% 帧序，
       二次滑动到底，符合"下拉/上提"的手势直觉。 */
    const ENTER_PX = 30;
    const coarse =
      typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const RANGE_PX = coarse
      ? Math.max(900, Math.min(1600, Math.round(window.innerHeight * 1.6)))
      : 2400;

    const renderer = createSegmentedSpriteRenderer({
      target: sprite,
      segments,
      frameCount,
      cellWidth,
      cellHeight,
      wrap: false, // 叙事时间轴：钳制停帧，首尾不相接
      autoPreload: false, // 单屏页无预热窗口，按需取段
    });

    let acc = 0; // 累计纵向输入（px），钳制在 [0, RANGE_PX]
    let active = false;

    const setActive = (on) => {
      active = on;
      if (on) {
        document.documentElement.dataset.scrub = 'on';
        sprite.hidden = false;
        heroSprite.hidden = true;
      } else {
        delete document.documentElement.dataset.scrub;
        sprite.hidden = true;
        heroSprite.hidden = false;
        acc = 0;
      }
    };

    const animator = createFrameAnimator({
      frameCount,
      wrap: false,
      render: (frame) => {
        renderer.render(frame);
        /* 倒回 f0（且输入已回到起点）→ 交还 hero 指针跟随。
           f0 与 hero rest 对齐，切换无跳变。 */
        if (active && acc <= 0 && frame === 0) setActive(false);
      },
    });

    function input(delta) {
      if (!active) {
        /* 只累计向下：在 rest 姿态向上滚没有可倒退的内容 */
        acc = Math.max(0, acc + delta);
        if (acc < ENTER_PX) return;
        setActive(true);
        acc -= ENTER_PX; // 越过阈值的部分立刻生效
      } else {
        acc = Math.max(0, Math.min(RANGE_PX, acc + delta));
        /* 边界：上提回到起点、且动画已归位到 f0 → 交还 hero。
           为什么不能只靠 animator 的 render 回调：回调只在**帧号变化**时触发，
           若激活后帧号一直是 0（越过阈值即归零的情形），回调永远不会来，
           状态机会卡在 scroll 模式，hero 画布再也回不来。 */
        if (delta < 0 && acc <= 0 && Math.round(animator.getCurrentFrame()) === 0) {
          setActive(false);
          return;
        }
      }
      animator.setProgress(acc / RANGE_PX);
    }

    /* 滚轮：line 模式（Firefox）按 ~40px/格 归一。passive:false 以便在
       scrub 生效期间阻止页面滚动（矮视口下 hero min-height 会产生滚动条）。 */
    window.addEventListener(
      'wheel',
      (event) => {
        const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        if (!delta) return;
        if (active || acc > 0) event.preventDefault();
        input(delta);
      },
      { passive: false }
    );

    /* ── 触摸：单指纵向拖动（2026-09-11 移动端适配）────────────────────
       手指下移（y 增大）= 向下拉 = 前进，与滚轮向下同义；上提 = 倒退。
       手势归属的三条规则：
       1. 轴向判定——首次位移超过 6px 时定轴：|dy| ≥ |dx| 判纵向（归 scrub），
          否则判横向并整段放行（把返回手势等留给浏览器，不抢）。
       2. 纵向一旦成立就 preventDefault，页面不滚、不回弹；
          除此之外的防线是 CSS 的 .stage{touch-action:none}（硬保证）。
       3. 不拦 pointer 事件——点卡定格、触他归位等既有触摸语义全部保留：
          tap（无位移）不产生有效累计，照样走 hero 的触摸契约。 */
    const AXIS_LOCK_PX = 6;
    let touchStart = null; // { x, y }
    let touchAxis = null; // 'v' | 'h' | null（未定轴）
    let lastTouchY = null;

    const resetTouch = () => {
      touchStart = null;
      touchAxis = null;
      lastTouchY = null;
    };

    window.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length !== 1) return resetTouch();
        const t = event.touches[0];
        touchStart = { x: t.clientX, y: t.clientY };
        touchAxis = null;
        lastTouchY = t.clientY;
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (event) => {
        if (lastTouchY == null || event.touches.length !== 1) return;
        const t = event.touches[0];
        const y = t.clientY;
        if (!touchAxis && touchStart) {
          const dx = Math.abs(t.clientX - touchStart.x);
          const dy = Math.abs(y - touchStart.y);
          if (dx > AXIS_LOCK_PX || dy > AXIS_LOCK_PX) touchAxis = dy >= dx ? 'v' : 'h';
        }
        if (touchAxis === 'h') {
          lastTouchY = y; // 横向手势：只跟位置，不消费位移
          return;
        }
        if (touchAxis === 'v') event.preventDefault();
        const delta = y - lastTouchY;
        lastTouchY = y;
        if (!delta) return;
        input(delta);
      },
      { passive: false }
    );
    window.addEventListener('touchend', resetTouch);
    window.addEventListener('touchcancel', resetTouch);
  } else {
    console.warn('[scrub] data-scrub-view 属性不完整，滚动 scrub 未启用：', view);
  }
}
