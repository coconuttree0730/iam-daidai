/* 帧随动运行时 —— 三个导出：
 *   createFrameAnimator()  把指针归一化位置映射为帧序号，smoothDamp 缓动
 *   createSpriteRenderer() 把帧序号写成 CSS background-position（纯 CSS 切图，46 帧单图）
 *   createSegmentedSpriteRenderer() 分段图集按需解码 + LRU 驻留（121 帧，canvas 切格）
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
  /* 时间轴拓扑开关（2026-09-11，滚动 scrub 页新增）：
   *   wrap: true（默认）= 圆环——帧 N−1 与帧 0 相邻，指针环绕跟随语义，hero 用；
   *   wrap: false       = 线性钳制——首尾不相接，拉到尽头停帧。
   * 线性时间轴若沿用环形 wrapDelta，"f0 再往下滚"会回绕到 f(N−1) 沿整条轴
   * 倒扫——圆环教训的反向应用：序列消费逻辑必须与时间轴拓扑同构。 */
  const wrap = options.wrap ?? true;
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
      /* 虚拟目标 = 当前位置 + 最短行程：圆环取回绕最短路径，线性直接取差值 */
      const delta = wrap ? wrapDelta(target - position) : target - position;
      const virtualTarget = position + delta;
      const change = clamp(position - virtualTarget, -maxChange, maxChange);
      const limitedTarget = position - change;
      const temp = (velocity + omega * change) * dt;
      velocity = (velocity - omega * temp) * decay;
      const next = limitedTarget + (change + temp) * decay;
      position = wrap ? wrapIndex(next) : clamp(next, 0, frameCount - 1);
      if ((virtualTarget - position > 0) === (position > virtualTarget)) {
        position = target;
        velocity = 0;
      }
    }

    const frame = wrap
      ? wrapIndex(Math.round(position))
      : Math.round(clamp(position, 0, frameCount - 1));
    if (frame !== lastFrame) {
      options.render(frame);
      lastFrame = frame;
    }

    const remaining = wrap ? wrapDelta(target - position) : target - position;
    if (Math.abs(remaining) > 0.002 || Math.abs(velocity) > 0.002) {
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
      return wrap ? wrapIndex(position) : clamp(position, 0, frameCount - 1);
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

/* ── 分段雪碧图渲染器（2026-09-11，121 帧方案）────────────────────────────
 * 按需解码 + LRU 驻留 + canvas 切格。为什么分段：
 *   解码位图内存 = 宽×高×4B（与文件压缩率无关），单张 121 帧图集需
 *   11×11 网格 ≈ 5302×6622（140MB）且远超移动 GPU 4096 纹理上限（超限降采样必糊）。
 *   6 段 WebP（4×6=24 格/段，1944×3576 ≤4096）按需 createImageBitmap，
 *   只驻留当前段 ± 环形邻段，离开的段 close() 真释放 → 峰值位图 2–3 段。
 *
 * ── 圆环同构（接缝白闪修复，2026-09-11）──────────────────────────────────
 * 帧随动把帧序当周长 N 的圆环（末帧↔首帧相邻），段调度必须同构：
 *   预取 (s±1+nSeg)%nSeg；驱逐按环形距离 min(|i−s|, nSeg−|i−s|) > 1。
 * 线性调度会让接缝两侧（seg0/seg5 段距 5）互判远段互相驱逐、互不预取，
 * 跨缝瞬间驻留清空。回归探针：demo-framewarp/.tmp/diag-seam/probe.mjs。
 *
 * ── 空窗防御 ──
 * clearRect 推迟到确定可画之后；无段可画时保留上一帧画面（不清屏不白闪）；
 * 首段解码落地前强制重画（否则启动时 lastRendered 已置数挡住后续调用，
 * 表现为「0 帧不显示」）。
 *
 * ── 两层缓存（2026-09-11，修线上跨段卡顿）────────────────────────────────
 * 指针移动本身零请求，但跨到未驻留段会触发 fetch。协商缓存（ETag）下每次
 * 回访仍有一次 RTT 往返（304），本地 ~3ms 无感、Cloudflare 上 50–150ms，
 * 等待期间旧帧滞留 = 可感卡顿。修法：把「下载」与「解码」分离——
 *   buffers    段号 → ArrayBuffer（压缩态，全 6 段常驻仅 3.9MB，首帧落地后预热）
 *   bitmaps    段号 → ImageBitmap（解码态，LRU 只驻留 ± 环形邻段，53–80MB）
 * 之后跨段只剩 createImageBitmap 解码（几十 ms），运行期零网络依赖。
 */
export function createSegmentedSpriteRenderer(options) {
  const frameCount = Math.max(1, Math.floor(options.frameCount));
  const cellWidth = Math.max(1, Math.floor(options.cellWidth));
  const cellHeight = Math.max(1, Math.floor(options.cellHeight));
  const segments = options.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('分段渲染器需要非空的 segments 清单');
  }
  const target = options.target;
  const ctx = target.getContext('2d');
  const frameLabel = options.frameLabel;
  /* 时间轴拓扑开关：wrap: true（默认）= 圆环形调度（hero 环绕语义）；
     false = 线性调度——预取 s±1 用边界 clamp、驱逐用线性距离。
     线性时间轴沿用环形调度会让 seg0 与末段被误判为相邻段：
     滚动页钳制在两端时末段/首段被无谓驻留，浪费的是 LRU 内存预算。 */
  const wrap = options.wrap ?? true;
  const bitmaps = new Map(); // 段号 → ImageBitmap（解码态，LRU 驻留）
  const buffers = new Map(); // 段号 → ArrayBuffer（压缩态，全段常驻）
  const bufferPromises = new Map(); // 段号 → Promise<ArrayBuffer>（预载去重）
  const inflight = new Set();
  const stats = { decodes: 0, evictions: 0, fallbacks: 0, prefetched: 0 };
  let destroyed = false;
  let drawnOnce = false;
  let lastRendered = -1;
  let pendingFrame = 0; // 最近一次请求的帧（含段未就绪的），供解码落地后补画

  const wrapIndex = (v) => ((v % frameCount) + frameCount) % frameCount;
  /* 帧号归一：圆环取模回绕；线性钳制进 [0, frameCount−1] */
  const normFrame = wrap
    ? wrapIndex
    : (v) => Math.max(0, Math.min(frameCount - 1, Math.round(v)));

  const segOfFrame = (f) => {
    for (let i = 0; i < segments.length; i++) {
      const g = segments[i];
      if (f >= g.first && f < g.first + g.count) return i;
    }
    return segments.length - 1;
  };

  /** 段压缩数据两层缓存的下层：fetch → ArrayBuffer，幂等（并行调用共享同一 Promise）。
      预载失败不缓存错误，下次调用自动重试。 */
  function ensureBuffer(i) {
    if (buffers.has(i)) return Promise.resolve(buffers.get(i));
    if (bufferPromises.has(i)) return bufferPromises.get(i);
    const p = fetch(segments[i].asset)
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        bufferPromises.delete(i);
        if (destroyed) return buf;
        buffers.set(i, buf);
        stats.prefetched++;
        return buf;
      })
      .catch((err) => {
        bufferPromises.delete(i);
        throw err;
      });
    bufferPromises.set(i, p);
    return p;
  }

  /** 首帧落地后预热全部段的压缩数据：运行期跨段不再碰网络。 */
  function preloadAllBuffers() {
    for (let i = 0; i < segments.length; i++) {
      ensureBuffer(i).catch(() => {}); // 预载失败静默，运行时 ensureSeg 兜底重试
    }
  }

  async function ensureSeg(i) {
    if (destroyed || i < 0 || i >= segments.length || bitmaps.has(i) || inflight.has(i)) return;
    inflight.add(i);
    try {
      const buf = await ensureBuffer(i);
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }));
      if (destroyed) {
        bmp.close();
        return;
      }
      bitmaps.set(i, bmp);
      stats.decodes++;
      if (!drawnOnce) {
        // 启动时序修复：首段就绪前 render 只能空转（无段可画直接返回），
        // lastRendered 已置数会挡住重画 —— 落地后强制补画最近请求的帧。
        lastRendered = -1;
        render(pendingFrame);
        if (drawnOnce) preloadAllBuffers(); // 首屏已保住，空闲带宽交给其余段
      }
    } finally {
      inflight.delete(i);
    }
  }

  function render(frame) {
    if (destroyed) return;
    const f = normFrame(frame);
    pendingFrame = f;
    if (drawnOnce && f === lastRendered) return;
    lastRendered = f;

    const s = segOfFrame(f);
    const nSeg = segments.length;
    // 当前段 + 邻段预取：圆环两侧互为邻段；线性按边界 clamp
    ensureSeg(s);
    if (wrap) {
      ensureSeg((s - 1 + nSeg) % nSeg);
      ensureSeg((s + 1) % nSeg);
    } else {
      if (s > 0) ensureSeg(s - 1);
      if (s < nSeg - 1) ensureSeg(s + 1);
    }
    // 远段驱逐，close() 真释放解码位图：圆环按环形距离，线性按直线距离
    for (const [i, bmp] of [...bitmaps]) {
      const d = Math.abs(i - s);
      const far = wrap ? Math.min(d, nSeg - d) > 1 : d > 1;
      if (far) {
        bmp.close();
        bitmaps.delete(i);
        stats.evictions++;
      }
    }

    let seg = s;
    let drawFrame = f;
    if (!bitmaps.has(s)) {
      // 目标段未就绪：已驻留段内最近帧兜底（缓动路径上邻段通常已就绪）
      let best = -1;
      let bd = Infinity;
      for (const [i, bmp] of bitmaps) {
        void bmp;
        const g = segments[i];
        const nf = Math.max(g.first, Math.min(f, g.first + g.count - 1));
        const dist = Math.abs(nf - f);
        if (dist < bd) {
          bd = dist;
          best = i;
        }
      }
      if (best >= 0) {
        const g = segments[best];
        drawFrame = Math.max(g.first, Math.min(f, g.first + g.count - 1));
        seg = best;
        stats.fallbacks++;
      } else {
        // 无段可画（首段解码中）：保留上一帧画面（不清屏），等解码落地回调补画
        return;
      }
    }

    const g = segments[seg];
    const k = drawFrame - g.first;
    ctx.clearRect(0, 0, cellWidth, cellHeight);
    ctx.drawImage(
      bitmaps.get(seg),
      (k % g.cols) * cellWidth,
      Math.floor(k / g.cols) * cellHeight,
      cellWidth,
      cellHeight,
      0,
      0,
      cellWidth,
      cellHeight
    );
    drawnOnce = true;
    /* 调试读帧通道：qa/verify-sprite-follow.mjs 从这里读当前帧
       （单图路径走 background-position 反解，canvas 路径没有 bg 可反解）。 */
    target.dataset.currentFrame = String(f);
    if (frameLabel) frameLabel.textContent = String(f);
  }

  return {
    render,
    getCapacity() {
      return frameCount;
    },
    getResidentBytes() {
      let bytes = 0;
      for (const bmp of bitmaps.values()) bytes += bmp.width * bmp.height * 4;
      return bytes;
    },
    getStats() {
      return { ...stats, resident: bitmaps.size };
    },
    destroy() {
      destroyed = true;
      for (const bmp of bitmaps.values()) bmp.close();
      bitmaps.clear();
      buffers.clear(); // ArrayBuffer 无 close，清引用交给 GC
      bufferPromises.clear();
    },
  };
}
