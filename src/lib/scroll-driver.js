/* 滚动驱动 —— 页面滚动进度 → 帧序号（线性时间轴，钳制停帧）
 *
 * 与 demo-driver.js（指针方向角、圆环）是并行的两条驱动路线，互不依赖：
 *   驱动哪个舞台、多少帧，全部写在 [data-scroll-sprite] 的 data-* 属性里——
 *   参数由页面构建时静态注入（与 hero 的 data-segments 契约同构）。
 *
 * 时间轴拓扑 = 线性：素材是叙事动作时间轴（站立→凑近→比耶→抱臂），
 * 首尾姿态不相接，滚动到尽头就停帧。因此 animator 与渲染器都传 wrap:false——
 * 若沿用环形调度，"f0 再往上滚"会被 wrapDelta 回绕到 f192 沿整条轴倒扫，
 * 段调度也会把 seg0 与末段误判为相邻段（圆环教训的反向应用）。
 *
 * 滚轮 / 触摸是同一件事的两个入口：浏览器把它们都翻译成 scroll 事件，
 * 原生惯性滚动自带"步进"手感，这里只做 进度→帧 的映射与 smoothDamp 缓动。
 *
 * 几何缓存：文档坐标（docTop/height）只在 resize / 字体就绪时测一次；
 * scroll 回调里只做算术，不读 getBoundingClientRect——滚动路径零强制布局。
 */
import {
  createFrameAnimator,
  createSegmentedSpriteRenderer,
} from '../lib/motion.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const readNumber = (value) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const views = document.querySelectorAll('[data-scroll-sprite]');
const mounted = [];

for (const view of views) {
  const target = view.querySelector('[data-sprite]');
  const frameCount = readNumber(view.dataset.frameCount);
  const cellWidth = readNumber(view.dataset.cellWidth);
  const cellHeight = readNumber(view.dataset.cellHeight);

  let segments = null;
  if (view.dataset.segments) {
    try {
      segments = JSON.parse(view.dataset.segments);
    } catch {
      console.warn('[scroll] data-segments JSON 非法，舞台已跳过：', view.id || view);
    }
  }

  if (!target || !frameCount || !segments || !cellWidth || !cellHeight) {
    console.warn('[scroll] 舞台缺少必需属性，已跳过：', view.id || view);
    continue;
  }

  const renderer = createSegmentedSpriteRenderer({
    target,
    frameLabel: view.querySelector('[data-frame]'),
    segments,
    frameCount,
    cellWidth,
    cellHeight,
    wrap: false, // 线性时间轴：段调度按边界 clamp，不环形回绕
    autoPreload: false, // 预热交给 IntersectionObserver 门控（见下）——
    // 与 hero 同页共存时不能在页面打开就全量预热 20 段（11MB）
  });

  const animator = createFrameAnimator({
    frameCount,
    wrap: false, // 线性时间轴：钳制停帧，f0/f(N−1) 不与对侧相接
    render: (frame) => renderer.render(frame),
  });

  mounted.push({ view, animator, renderer, docTop: 0, trackLen: 1, preloaded: false });
}

/* 预热门控：滚动区进入视口 ±80% 范围才开始预热全部段压缩数据。
   用户从 hero 开始往下滚的那一段行程正好是预热窗口——
   等滚动区真正覆盖视口时，段基本已在本地产出，scrub 路径只剩解码。 */
if (typeof IntersectionObserver === 'function') {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const m = mounted.find((x) => x.view === entry.target);
        if (m && !m.preloaded) {
          m.preloaded = true;
          m.renderer.preloadAll();
        }
      }
    },
    { rootMargin: '80% 0px 80% 0px' }
  );
  for (const m of mounted) io.observe(m.view);
} else {
  for (const m of mounted) m.renderer.preloadAll();
}

/* 几何：文档坐标缓存，resize 时重测 */
const measure = () => {
  for (const m of mounted) {
    const rect = m.view.getBoundingClientRect();
    m.docTop = rect.top + window.scrollY;
    /* 舞台高度 − 一屏 = 滚动行程；sticky 视口在这段行程内钉在屏上 */
    m.trackLen = Math.max(1, rect.height - window.innerHeight);
  }
};

const applyProgress = () => {
  const y = window.scrollY;
  for (const m of mounted) {
    /* p: 0 = 舞台顶边碰到视口顶，1 = 舞台底边碰到视口底 */
    m.animator.setProgress(clamp01((y - m.docTop) / m.trackLen));
  }
};

if (mounted.length) {
  measure();
  if (document.fonts?.ready) document.fonts.ready.then(measure);
  window.addEventListener('resize', () => {
    measure();
    applyProgress();
  }, { passive: true });
  window.addEventListener('scroll', applyProgress, { passive: true });
  window.addEventListener('load', measure);
  applyProgress(); // 载入即按当前滚动位置定位（含刷新后浏览器恢复的滚动点）
}
