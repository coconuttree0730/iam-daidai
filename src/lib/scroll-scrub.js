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
    /* 手感参数：进入阈值防误触；满行程的累计滚动量（px）决定 scrub 速率。
       2400px ≈ 触摸板三记轻扫 / 滚轮约 24 格走完 193 帧，可按手感单点调整。 */
    const ENTER_PX = 30;
    const RANGE_PX = 2400;

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
    let lastTouchY = null;

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

    /* 触摸：单指纵向拖动。手指下移（y 增大）= 向下拉 = 前进，与滚轮向下同义。
       不拦 pointer 事件——点卡定格、触他归位等既有触摸语义全部保留：
       tap（无位移）不会产生有效累计，照样走 hero 的触摸契约。 */
    window.addEventListener(
      'touchstart',
      (event) => {
        lastTouchY = event.touches.length === 1 ? event.touches[0].clientY : null;
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (event) => {
        if (lastTouchY == null || event.touches.length !== 1) return;
        const y = event.touches[0].clientY;
        const delta = y - lastTouchY;
        lastTouchY = y;
        if (!delta) return;
        if (active || acc > 0) event.preventDefault();
        input(delta);
      },
      { passive: false }
    );
    window.addEventListener('touchend', () => {
      lastTouchY = null;
    });
    window.addEventListener('touchcancel', () => {
      lastTouchY = null;
    });
  } else {
    console.warn('[scrub] data-scrub-view 属性不完整，滚动 scrub 未启用：', view);
  }
}
