/* 帧随动运行时 —— 只有两个导出：
 *   createFrameAnimator()  把指针归一化位置映射为帧序号，smoothDamp 缓动
 *   createSpriteRenderer() 把帧序号写成 CSS background-position（纯 CSS 切图）
 *
 * 交付格式为 alpha-atlas：抠色在离线阶段完成并烤进 WebP 的 alpha 通道，
 * 运行时不需要 WebGL，也不需要视频解码器。纹理预算门结论见
 * motion/head-turn/build/motion-budget-atlas.json。
 */

/* 帧随动控制器：smoothDamp 缓动，与手写 demo 的曲线一致。
 *
 * ── 圆环模型（2026-09-11 修复"右下乱跳"）────────────────────────────────
 * 帧序不是线性轴，是周长 = frameCount 的**圆环**：帧 N−1 与帧 0 相邻
 * （素材回正帧 ≈ 正面帧；角度空间里 phi 360° ≡ 0°，接缝两侧本就该无缝衔接）。
 * 旧实现直接对线性 target 做 smoothDamp，接缝两侧 target 跳变 45↔0 时
 * 会沿线性轴倒扫整段帧序（实测一次过渡倒带 24 帧），表现即"右下区域乱跳"——
 * 因为只有接缝和死区的 BR 侧落差最大（45↔0、34↔0），其余边界落差 ≤ 11 帧。
 * 修复：每帧先把 (target − position) 回绕到圆环最短路径再缓动，渲染时
 * round(position) 对周长取模（45.9 → 46 → 0），收敛判据同样用回绕差值。
 */
export function createFrameAnimator(options) {
  const frameCount = Math.max(1, Math.floor(options.frameCount));
  const smoothTime = options.smoothTime ?? 0.11;
  const maxSpeed = options.maxSpeed ?? frameCount * 2;
  const reducedMotion = options.reducedMotion ?? false;
  const CIRCLE = frameCount; // 圆环周长（帧单位）：帧 N−1 与帧 0 间距 1
  let position = Math.min(frameCount - 1, Math.max(0, options.initialFrame ?? 0));
  let target = position;
  let velocity = 0;
  let lastFrame = -1;
  let lastTime = 0;
  let raf = 0;
  let destroyed = false;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /* 圆环差值：把 d 回绕到 (−C/2, C/2]，即最短路径的有符号行程 */
  const wrapDelta = (d) => {
    d = ((d % CIRCLE) + CIRCLE) % CIRCLE;
    return d > CIRCLE / 2 ? d - CIRCLE : d;
  };
  /* 位置回绕进 [0, C)：46 → 0（跨接缝后落回轴的正半圈） */
  const wrapIndex = (v) => ((v % CIRCLE) + CIRCLE) % CIRCLE;

  const loop = (now) => {
    raf = 0;
    if (destroyed) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 1 / 30) : 1 / 60;
    lastTime = now;

    if (reducedMotion) {
      position = target;
      velocity = 0;
    } else {
      const omega = 2 / Math.max(0.0001, smoothTime);
      const x = omega * dt;
      const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const maxChange = maxSpeed * smoothTime;
      /* 虚拟目标 = 当前位置 + 圆环最短路径；smoothDamp 公式原样作用于它 */
      const virtualTarget = position + wrapDelta(target - position);
      const change = clamp(position - virtualTarget, -maxChange, maxChange);
      const limitedTarget = position - change;
      const temp = (velocity + omega * change) * dt;
      velocity = (velocity - omega * temp) * decay;
      position = wrapIndex(limitedTarget + (change + temp) * decay);
      if ((virtualTarget - position > 0) === (position > virtualTarget)) {
        position = target;
        velocity = 0;
      }
    }

    const frame = wrapIndex(Math.round(position));
    if (frame !== lastFrame) {
      options.render(frame);
      lastFrame = frame;
    }

    if (Math.abs(wrapDelta(target - position)) > 0.002 || Math.abs(velocity) > 0.002) {
      raf = requestAnimationFrame(loop);
    }
  };

  const initial = Math.round(clamp(position, 0, frameCount - 1));
  options.render(initial);
  lastFrame = initial;

  return {
    setProgress(progress) {
      target = clamp(progress, 0, 1) * (frameCount - 1);
      if (!raf && !destroyed) raf = requestAnimationFrame(loop);
    },
    getCurrentFrame() {
      return wrapIndex(position);
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/* 雪碧图渲染器：把帧序号写成 CSS background-position。
 *
 * 定位公式（已做 46/46 帧像素级验证）：
 *   background-size     = `${columns * 100}% ${rows * 100}%`
 *   background-position = `${(column / (columns - 1)) * 100}% ${(row / (rows - 1)) * 100}%`
 *
 * 为什么用百分比而不是 `-Npx`：百分比定位会按「容器尺寸 - 图集缩放后尺寸」
 * 的剩余空间来算，因此与元素的最终 CSS 宽度解耦——同一份样式在任意屏幕、
 * 任意 DPR 下都自动对齐，不需要监听 resize 重算。改成 px 就会失去这个性质。
 *
 * 前提：图集里没有留空的尾格（frameCount ≤ columns × rows），否则末行会错位。
 */
export function createSpriteRenderer(options) {
  const frameCount = Math.max(1, Math.floor(options.frameCount));
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows));
  const capacity = columns * rows;

  if (frameCount > capacity) {
    throw new Error(
      `帧数 ${frameCount} 超出图集容量 ${capacity}（${columns} 列 × ${rows} 行），末行会错位`
    );
  }

  const target = options.target;
  target.style.backgroundImage = `url("${options.asset}")`;
  target.style.backgroundRepeat = 'no-repeat';
  target.style.backgroundSize = `${columns * 100}% ${rows * 100}%`;

  const frameLabel = options.frameLabel;

  return {
    render(frame) {
      const index = Math.max(0, Math.min(frameCount - 1, Math.round(frame)));
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = columns === 1 ? 0 : (column / (columns - 1)) * 100;
      const y = rows === 1 ? 0 : (row / (rows - 1)) * 100;
      target.style.backgroundPosition = `${x}% ${y}%`;
      if (frameLabel) frameLabel.textContent = String(index);
    },
    getCapacity() {
      return capacity;
    },
  };
}
