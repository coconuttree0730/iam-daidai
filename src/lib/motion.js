/* 帧随动运行时 —— 只有两个导出：
 *   createFrameAnimator()  把指针归一化位置映射为帧序号，smoothDamp 缓动
 *   createSpriteRenderer() 把帧序号写成 CSS background-position（纯 CSS 切图）
 *
 * 交付格式为 alpha-atlas：抠色在离线阶段完成并烤进 WebP 的 alpha 通道，
 * 运行时不需要 WebGL，也不需要视频解码器。纹理预算门结论见
 * motion/head-turn/build/motion-budget-atlas.json。
 */

/* 帧随动控制器：smoothDamp 缓动，与手写 demo 的曲线一致 */
export function createFrameAnimator(options) {
  const frameCount = Math.max(1, Math.floor(options.frameCount));
  const smoothTime = options.smoothTime ?? 0.11;
  const maxSpeed = options.maxSpeed ?? frameCount * 2;
  const reducedMotion = options.reducedMotion ?? false;
  let position = Math.min(frameCount - 1, Math.max(0, options.initialFrame ?? 0));
  let target = position;
  let velocity = 0;
  let lastFrame = -1;
  let lastTime = 0;
  let raf = 0;
  let destroyed = false;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

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
      const change = clamp(position - target, -maxChange, maxChange);
      const limitedTarget = position - change;
      const temp = (velocity + omega * change) * dt;
      velocity = (velocity - omega * temp) * decay;
      position = limitedTarget + (change + temp) * decay;
      if ((target - position > 0) === (position > target)) {
        position = target;
        velocity = 0;
      }
    }

    const frame = Math.round(clamp(position, 0, frameCount - 1));
    if (frame !== lastFrame) {
      options.render(frame);
      lastFrame = frame;
    }

    if (Math.abs(target - position) > 0.002 || Math.abs(velocity) > 0.002) {
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
      return clamp(position, 0, frameCount - 1);
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
