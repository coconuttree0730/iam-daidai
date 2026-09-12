// /works/ 卡片轨道驱动（2026-09-12 建，参考 rauno.me 的交互）。
//
// 交互契约：
// - 四种输入折算成同一份逻辑进度 target（px）：竖向滚轮、触控板横扫
//   （deltaX）、指针/触摸拖拽、← → / Home / End 键。rAF 指数缓动逼近
//   target，收敛即停帧（不空转 rAF）。
// - 拖拽期 1:1 跟手（pos 直接贴 target），松手后按末速度惯性续滑，
//   再进入缓动收敛。
// - 位移写在本页 .rail 的 transform 上。hero「叠位移用独立 translate
//   属性」的契约针对的是 hero .card 的 transform 顺序，本元素不在其列；
//   本页不加载 scroll-scrub，不消费 --sc，两套进度互不干扰。
// - 页面版式锁 100dvh 无文档滚动，滚轮可全权接管；若异常出现文档级
//   可滚动（极矮屏兜底失效），wheel 直接放行，避免吞掉页面滚动。
// - 捏合缩放（ctrl+wheel）不接管。尊重 prefers-reduced-motion：时间
//   常数取 0，输入直接贴齐目标。
// - 拖拽位移 >6px 视为拖拽而非点击：capture 阶段吞掉紧随的 click，
//   防止松手时误触卡片链接；无 click 跟随（松在空白处）则由微任务
//   计时器复位标记。
//
// 帧循环里同时渲染三处：轨道位移、进度条 scaleX、计数器读数。

const LINE = 16; // deltaMode === 1（行）时的像素折算

export function createWorksRail({ viewport, rail, nowEl, progressEl, frameEl, rulerEl, total = 1 }) {
  let max = 0;        // 可横移总里程 px
  let frameMax = 0;   // 顶部刻度尺上游标可移动里程 px
  let target = 0;     // 逻辑进度（0..max）
  let pos = 0;        // 渲染进度
  let raf = 0;
  let lastT = 0;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  function render() {
    rail.style.transform = `translate3d(${-pos}px,0,0)`;
    const p = max > 0 ? pos / max : 0;
    if (progressEl) progressEl.style.transform = `scaleX(${p})`;
    if (frameEl) frameEl.style.transform = `translate3d(${p * frameMax}px,0,0)`;
    if (nowEl) {
      const idx = max > 0 ? Math.round(p * Math.max(0, total - 1)) : 0;
      nowEl.textContent = String(idx + 1).padStart(2, '0');
    }
  }

  function tick(t) {
    raf = 0;
    const dt = lastT ? Math.min(0.064, (t - lastT) / 1000) : 0.016;
    lastT = t;
    const tau = reduce.matches ? 0 : 0.26; // 时间常数：越大越「黏」
    pos = tau > 0 ? pos + (target - pos) * (1 - Math.exp(-dt / tau)) : target;
    if (Math.abs(target - pos) < 0.05) pos = target;
    render();
    if (pos !== target) {
      raf = requestAnimationFrame(tick);
    } else {
      lastT = 0;
    }
  }

  function kick() {
    if (!raf) {
      lastT = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  function measure() {
    max = Math.max(0, rail.scrollWidth - viewport.clientWidth);
    frameMax = frameEl && rulerEl
      ? Math.max(0, rulerEl.clientWidth - frameEl.offsetWidth)
      : 0;
    target = clamp(target, 0, max);
    if (!raf) {
      pos = clamp(pos, 0, max);
      render();
    }
  }

  // ── 滚轮：竖向为主，横向为辅（触控板双指横扫直接给 deltaX）──
  function onWheel(e) {
    if (e.ctrlKey) return; // 捏合缩放放行
    if (document.documentElement.scrollHeight > window.innerHeight + 2) return;
    let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    if (e.deltaMode === 1) d *= LINE;
    else if (e.deltaMode === 2) d *= window.innerHeight;
    e.preventDefault();
    target = clamp(target + d, 0, max);
    kick();
  }

  // ── 拖拽（鼠标 + 触摸同一套 pointer 事件）──
  let dragging = false;
  let moved = false; // 本次手势是否够格算「拖拽」（吞 click 用）
  let lastX = 0;
  let accX = 0;
  let lastVX = 0; // px/ms
  let lastVT = 0;

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    moved = false;
    lastX = e.clientX;
    accX = 0;
    lastVX = 0;
    lastVT = performance.now();
    viewport.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    accX += dx;
    if (!moved && Math.abs(accX) > 6) moved = true;
    if (moved) {
      target = clamp(target - dx, 0, max);
      pos = target; // 拖拽期 1:1 跟手，松手后才进缓动
      const t = performance.now();
      const dts = t - lastVT;
      if (dts > 0) {
        lastVX = dx / dts;
        lastVT = t;
      }
      kick();
    }
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    if (viewport.hasPointerCapture?.(e.pointerId)) {
      viewport.releasePointerCapture(e.pointerId);
    }
    if (moved) {
      // 惯性：松手速度（px/ms）换算成续滑里程
      target = clamp(target - lastVX * 160, 0, max);
      kick();
      // click 在 pointerup 之后同步派发；微任务计时器等它过去再复位
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

  // ── 键盘（页面无输入框，window 级监听安全）──
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let next = null;
    if (e.key === 'ArrowRight') next = target + viewport.clientWidth * 0.35;
    else if (e.key === 'ArrowLeft') next = target - viewport.clientWidth * 0.35;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    target = clamp(next, 0, max);
    kick();
  }

  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  viewport.addEventListener('pointerdown', onDown);
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
  viewport.addEventListener('pointercancel', onUp);
  viewport.addEventListener('click', onClickCapture, true);
  window.addEventListener('resize', measure);
  // 字体换帧会改变轨道宽度，换帧完成后重测
  document.fonts?.ready?.then(measure);

  measure();
  render();

  return {
    measure,
    destroy() {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', measure);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
