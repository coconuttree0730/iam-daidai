// ── 绘画墙挂载（/works/09/ 与 /en/works/09/ 共用，2026-09-15）──────────────
//
// 与 src/styles/sketchbook.css 配对。中英文两页各自只写：
//     import { mountSketchbookWall } from '../../lib/sketchbook.js';
//     mountSketchbookWall();
//
// ── 职责（只做三件事，版式与摆放不在 JS 里）─────────────────────────────
//   1. 布局：把每件 .sb-piece 的 data-x / data-y / data-w / data-rot / data-z
//      写成内联的 left/top/width/rotate/z-index，并把 .sb-track 撑到足够宽
//      ⚠️ 摆放数值来自 profile.json，**不在 JS 里发明坐标**——这里只做
//         「百分比 → px」的换算与宽度撑开，改摆放请改数据。
//   2. 手机档缩放：vw < 640 时把宽度整体乘一个系数，使不规则的相对位置
//      原样保留——是**整体**缩放，不是重新排版。
//   3. 输入：拖拽 / 滚轮 / 左右按钮 / ← → 键，统一落到 .sb-wall.scrollLeft。
//      用原生滚动容器承接（浏览器的触控板惯性比自实现更顺手）。
//
// ── 为什么不用百分比宽度（重要）──────────────────────────────────────────
//   .sb-piece 用 `left: X%` 定位，而百分比的分母是**轨道宽**——轨道宽又被
//   「最右一件要多宽才放得下」反过来决定，形成循环依赖。若 width 也用百分比，
//   这个环就解不开（一件的 px 宽还取决于待求的轨道宽）。故 width 取 px：
//   右缘需求变成 W ≥ (x%·W + w) ⇒ W ≥ w / (1 − x/100)，可直接闭式求解。
//   本文件里那句 maxRight 就是它的实现。
//
// ── 契约 ────────────────────────────────────────────────────────────────
// ⚠️ **本脚本只写 left/top/width/rotate/z-index 与 scrollLeft，绝不写
//    transform**：transform 留给未来的动画层（hover 抬升走独立 translate
//    属性，见 sketchbook.css 文件头）。这是 MEMORY 里「叠加位移永不塞进
//    transform」那条全局契约在本页的落点。
//
// ⚠️ 墙高由 CSS 的 --sb-h 单独决定（单一来源）。JS 读它的**实测值**
//    （clientHeight）把 y% 折算成 px 写进 top——因为轨道高本身要按内容反推，
//    若 top 也用百分比就会形成「轨道高 → top → 轨道高」的循环依赖（见 layout）。
//    改 --sb-h 不需要动数据，JS 会自然跟上。
//
// ⚠️ 轨道高度（minHeight）由 layout() **实测**每件的 offsetTop + offsetHeight
//    回写：绝对定位子元素不撑父元素，不回写就会让最下面那件的 caption 被裁。

/** 手机档整体缩放系数（桌面 1）：与 sketchbook.css 的 ≤640px 外壳收紧配套 */
const MOBILE_SCALE = 0.62;
/** 移动断点：与全站 1100·900·640 体系一致，也与 works-rail 的换轴判据同源 */
const BP_MOBILE = 640;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

export function mountSketchbookWall() {
  const wall = document.querySelector('[data-sb-wall]');
  const track = document.querySelector('[data-sb-track]');
  if (!wall || !track) return null;

  const pieces = Array.from(track.querySelectorAll('.sb-piece'));
  const btnPrev = document.querySelector('[data-sb-prev]');
  const btnNext = document.querySelector('[data-sb-next]');

  /** 每件的原始数据（只在初始化时读一次，之后缩放都基于它，不叠乘） */
  const base = pieces.map((el) => ({
    el,
    x: Number(el.dataset.x ?? 0),        // 左缘，轨道宽百分比
    y: Number(el.dataset.y ?? 0),        // 上缘，轨道高百分比
    w: Number(el.dataset.w ?? 320),      // 宽度 px（桌面档）
    rot: Number(el.dataset.rot ?? 0),    // 旋转角（度；数据侧已封顶 ≤14°）
    z: Number(el.dataset.z ?? 1),
  }));

  let contentW = 0;
  let onResize = null;

  function wallInnerWidth() {
    const cs = getComputedStyle(wall);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return Math.max(0, wall.clientWidth - padL - padR);
  }

  /** 墙的净高（clientHeight − 上下内缩）。纵向锚点以它为基准。 */
  function wallInnerHeight() {
    const cs = getComputedStyle(wall);
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    return Math.max(0, wall.clientHeight - padT - padB);
  }

  function layout() {
    const vw = window.innerWidth;
    const isMobile = vw < BP_MOBILE;
    const scale = isMobile ? MOBILE_SCALE : 1;
    const avail = Math.max(220, vw - 28); // 手机档：视口 − .sb-wall 左右各 14 内缩

    let maxRight = 0;
    const innerH = wallInnerHeight();

    for (const p of base) {
      let w = p.w * scale;
      // 任何一件都不该比可用宽还宽（否则左缘即使是 0% 也放不下）
      if (isMobile && w > avail) w = avail;

      p.el.style.width = `${Math.round(w)}px`;
      p.el.style.left = `${p.x}%`;
      // ⚠️ top 用 px（不写百分比）：百分比的分母是轨道高，而轨道高又要按
      //    「内容总高」反推——又是一个循环依赖。此处以墙的**净高**为基准
      //    把 y% 折算成 px，基准是外部给定的（--sb-h），环就断了。
      p.el.style.top = `${Math.round((p.y / 100) * innerH)}px`;
      p.el.style.rotate = `${p.rot}deg`;
      p.el.style.zIndex = String(p.z);

      // 右缘需求（闭式解，见文件头「为什么不用百分比宽度」）：
      //   x%·W + w ≤ W  ⇒  W ≥ w / (1 − x/100)
      // 再加 0.5w 的呼吸余量，避免最右一件紧贴墙边（caption 也不算被截）。
      const k = 1 - p.x / 100;
      if (k > 0.02) maxRight = Math.max(maxRight, w / k + w * 0.5);
      else maxRight = Math.max(maxRight, w * 3); // x ≥ 98% 的兜底，不该出现
    }

    contentW = Math.ceil(Math.max(wallInnerWidth(), maxRight + 24));
    track.style.minWidth = `${contentW}px`;

    // ── 轨道的实际高度 = 内容需要的最大高度（不短于墙面净高）─────────────
    // 绝对定位子元素不撑父元素，所以必须**实测**每件的 bottom 再回写 minHeight。
    // 这一步让「caption 被裁」从「靠调数字避免」变成「结构上不可能」。
    let needH = innerH;
    for (const p of base) {
      const el = p.el;
      // offsetTop/offsetHeight 是相对 offsetParent（= .sb-track）的 px 值；
      // 此时 parent 高度尚未被本行改写，读数稳定。
      needH = Math.max(needH, el.offsetTop + el.offsetHeight + 6);
    }
    track.style.minHeight = `${Math.ceil(needH)}px`;

    syncButtons();
  }

  function maxScroll() {
    return Math.max(0, wall.scrollWidth - wall.clientWidth);
  }

  function syncButtons() {
    const max = maxScroll();
    if (btnPrev) btnPrev.disabled = wall.scrollLeft <= 1;
    if (btnNext) btnNext.disabled = wall.scrollLeft >= max - 1;
  }

  // ── 拖拽：pointer 事件统一鼠标与触摸。位移 >6px 才算拖拽，随后吞掉 click，
  //    防止「想挪墙却点进了画作」（与 works-rail.js 同一套语义）。──
  let dragging = false;
  let moved = false;
  let pointerId = -1;
  let lastX = 0;
  let lastT = 0;
  let vel = 0;
  let raf = 0;

  function glide() {
    raf = 0;
    if (dragging || Math.abs(vel) < 0.05) {
      vel = 0;
      return;
    }
    wall.scrollLeft -= vel * 16;
    vel *= 0.92;
    syncButtons();
    raf = requestAnimationFrame(glide);
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    moved = false;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastT = performance.now();
    accX = 0;
    vel = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // 累积位移（判定「点击 vs 拖拽」）：与 works-rail.js 同阈值 6px——
  // 指下后头几个像素的抖动不该把一次点击变成拖拽。
  let accX = 0;

  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    accX += dx;
    if (!moved) {
      if (Math.abs(accX) <= 6) return; // 还没超过阈值：窗口内小抖动，不转态
      moved = true;
      wall.classList.add('sb-wall--dragging');
    }
    wall.scrollLeft -= dx;
    const t = performance.now();
    const dt = t - lastT;
    if (dt > 0) vel = dx / dt;
    lastT = t;
    syncButtons();
  }

  function onUp(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    accX = 0;
    wall.classList.remove('sb-wall--dragging');
    if (Math.abs(vel) > 0.25) {
      if (!raf) raf = requestAnimationFrame(glide);
    } else {
      vel = 0;
    }
    // 拖拽过就吞掉紧随的 click（微任务后复位，与 works-rail.js 同法）
    if (moved) {
      setTimeout(() => {
        moved = false;
      }, 0);
    }
  }

  function onClickCapture(e) {
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // 纵向滚轮折算横向：墙面横向溢出时，滚轮 = 挪墙（用户直觉）。
  // 只有「确实还能往那个方向滚」才 preventDefault，否则放行给页面纵向滚动
  // ——否则墙面到头后页面会被彻底卡住（这是这类横向容器最常见的可达性坑）。
  function onWheel(e) {
    if (e.ctrlKey) return;
    const max = maxScroll();
    if (max <= 1) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    const atStart = wall.scrollLeft <= 0 && d < 0;
    const atEnd = wall.scrollLeft >= max - 0.5 && d > 0;
    if (atStart || atEnd) return;
    e.preventDefault();
    wall.scrollLeft += d;
    syncButtons();
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const stepPx = wall.clientWidth * 0.6;
    if (e.key === 'ArrowRight') wall.scrollLeft += stepPx;
    else if (e.key === 'ArrowLeft') wall.scrollLeft -= stepPx;
    else if (e.key === 'Home') wall.scrollLeft = 0;
    else if (e.key === 'End') wall.scrollLeft = wall.scrollWidth;
    else return;
    e.preventDefault();
    syncButtons();
  }

  btnPrev?.addEventListener('click', () => {
    wall.scrollBy({ left: -wall.clientWidth * 0.7, behavior: 'smooth' });
    setTimeout(syncButtons, 340);
  });
  btnNext?.addEventListener('click', () => {
    wall.scrollBy({ left: wall.clientWidth * 0.7, behavior: 'smooth' });
    setTimeout(syncButtons, 340);
  });

  wall.addEventListener('pointerdown', onDown);
  wall.addEventListener('pointermove', onMove);
  wall.addEventListener('pointerup', onUp);
  wall.addEventListener('pointercancel', onUp);
  wall.addEventListener('click', onClickCapture, true);
  wall.addEventListener('scroll', syncButtons, { passive: true });
  wall.addEventListener('wheel', onWheel, { passive: false });
  wall.addEventListener('keydown', onKey);

  let resizeTimer = 0;
  onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const before = wall.scrollLeft;
      layout();
      wall.scrollLeft = clamp(before, 0, maxScroll());
    }, 120);
  };
  window.addEventListener('resize', onResize);

  layout();
  // 字体就位后 Great Vibes 的实测宽会变（caption 换行），补测一次宽度。
  document.fonts?.ready?.then(() => layout());

  return {
    layout,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (onResize) window.removeEventListener('resize', onResize);
    },
  };
}
