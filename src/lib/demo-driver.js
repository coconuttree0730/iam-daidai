/* 指针驱动 —— 帧随动 + 卡片视差
 *
 * 设计原则：脚本只读 DOM。驱动哪个舞台、网格多大、多少帧，全部写在
 * [data-sprite-view] 的 data-* 属性里——新增/删除面板只需改页面，
 * 不需要碰这个文件。这里只留「怎么驱动」，不留「驱动谁」。
 *
 * 参数在构建时静态 import，不是运行时 fetch。早期版本用 fetch('motion.json')，
 * 在 file:// 下抛 TypeError，且位于 IIFE 最前面，会中断整个脚本；
 * 静态 import 后运行时零网络依赖，参数也享受打包器的路径校验。
 *
 * 图集元数据有两个来源，同源不同字段：
 *   src/data/*-meta.json   供构建时 import（精简字段 + 带前导斜杠的资源路径）
 *   public/motion/*.json   流水线原始产物（含 files[] 逐帧清单），运行时不需要
 *
 * 指针载荷：{ x, y, progress }
 *   x, y      指针在**舞台**内的归一化位置（0–1，已 clamp）→ 供卡片视差
 *   progress  帧随动进度（0–1）→ 锚点舞台的进度，向后兼容保留
 *
 * ── 几何归属：每个舞台各自一套（2026-09-10 起）──────────────────────────
 * 帧随动的坐标系是「指针相对**该舞台自己的**人物图片区域的方向角」。
 * 页面上同时存在多个人物（A/B 对比区）时，用同一个极点会让靠边的那一个
 * 看起来"没在看指针"——所以每个 [data-sprite-view] 各自缓存自己的
 * 人物矩形与可达角度区间，各自算 progress，互不干扰。
 * 视差仍旧只属于页面级：它要的是"指针在版面里的相对位置"，
 * 所以统一用**锚点舞台**的矩形归一化。
 *
 * 早前两者共用一个 x：舞台矩形归一化后又 clamp，于是指针移到视口四角时
 * x 被压到 0 或 1 —— (0,0) 永远播第 0 帧、右上角永远播末帧，且 y 维度完全丢失
 * （同一列的上下两点给出同一帧）。方向角的推导见 src/lib/pointer-frame.js。
 *
 * 人物图片区域矩形 = 立绘元素盒按**内容框**内缩，内缩量由 data-person-inset 给出
 * （左 上 右 下，四个 0–1 的分数，相对元素盒）。图集打包时按全部帧的墨迹并集
 * 裁切，四边各留透明垫；"区域内 = 首帧"要指的是人物图片的实际区域，
 * 所以这里收一次。数值来自各自 src/data/*-meta.json 的 contentBox。
 *
 * 象限可达角度区间（spans）在几何变化时预算一次，见 measure()。它不是可选优化：
 * 人物矩形底边贴视口底边时，"正下方"整条方向被死区占满，不归一化会让左下段首、
 * 右下段尾的帧永远取不到。
 */
import {
  createSpriteRenderer,
  createSegmentedSpriteRenderer,
  createFrameAnimator,
} from '../lib/motion.js';
import { createCardParallax } from '../lib/parallax.js';
import { progressFromPointer, reachableSpans } from '../lib/pointer-frame.js';

const subscribers = [];
const state = { x: 0.5, y: 0.5, progress: 0 };
let queued = false;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* 指针事件一帧可能来很多次（高刷屏、高 DPI 鼠标），统一用 rAF 合帧，
   避免每张卡片、每个人物每次移动都写一遍 style。
   帧随动不订阅 state：它要的是**原始指针坐标**，不是舞台归一化后的值，
   所以这里单独存一份，由 applyProgress() 逐舞台现算。 */
const pointer = { x: 0, y: 0, active: false, type: '' };

/* 触摸语义（2026-09-11 用户简化指定）：
   点四张卡（data-look-frame）→ 定格到卡片配帧；触其他任何位置 → 回首帧（正面）。
   曾试过"看向触点"（360° 圆环 / 水平姿态带两种），都被否决——
   素材时间轴两端都是正面（f0 正面、f45 回正），底部区域怎么映射都像"归位"，
   干脆显式归位，语义最干净。鼠标路径完全不变。 */

const flush = () => {
  queued = false;
  applyProgress();
  for (const fn of subscribers) fn(state);
};

const emit = (next) => {
  if (next.x !== undefined) state.x = clamp01(next.x);
  if (next.y !== undefined) state.y = clamp01(next.y);
  if (next.progress !== undefined) state.progress = clamp01(next.progress);
  if (!queued) {
    queued = true;
    requestAnimationFrame(flush);
  }
};

const readNumber = (value) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/* "左 上 右 下" 四个 0–1 的分数（相对元素盒）。写错就退回不内缩，
   宁可把透明垫算进去，也不要因为一个笔误让死区变成空集。 */
const readInsets = (value) => {
  const n = String(value ?? '').trim().split(/\s+/).map(Number);
  const ok = n.length === 4 && n.every((v) => Number.isFinite(v) && v >= 0 && v < 1);
  if (!ok) {
    if (value !== undefined) console.warn('[motion] data-person-inset 非法，已忽略：', value);
    return [0, 0, 0, 0];
  }
  return n;
};

/* 姿态重定时表（可选，data-frame-warp="进度:帧 进度:帧 …"）。
 * 素材是手势时间轴而非朝向库，姿态峰不在象限段中心（2026-09-11 逐帧质心实测：
 * 看左峰 f14=30.4%、看右峰 f25=54.3%），线性映射会让左半区领先一个象限。
 * 控制点写在 atlas-meta.json 的 frameWarp，由页面展开成属性；解析失败退回恒等。
 * 返回 进度→进度 的单调分段线性函数。 */
const parseFrameWarp = (value, frameCount) => {
  const last = Math.max(1, frameCount - 1);
  const pts = String(value ?? '')
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((pair) => pair.split(':').map(Number))
    .filter(([p, f]) => Number.isFinite(p) && Number.isFinite(f))
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) {
    if (value !== undefined) console.warn('[motion] data-frame-warp 非法，已忽略：', value);
    return null;
  }
  return (p) => {
    if (p <= pts[0][0]) return clamp01(pts[0][1] / last);
    if (p >= pts[pts.length - 1][0]) return clamp01(pts[pts.length - 1][1] / last);
    for (let i = 1; i < pts.length; i++) {
      if (p <= pts[i][0]) {
        const [p0, f0] = pts[i - 1];
        const [p1, f1] = pts[i];
        const t = (p - p0) / (p1 - p0 || 1);
        return clamp01((f0 + t * (f1 - f0)) / last);
      }
    }
    return clamp01(p);
  };
};

/* 视口矩形 = 指针能到达的范围。帧随动的可达角度由它封顶，
   所以必须用视口而不是舞台——监听器挂在整个文档上。 */
const viewportRect = () => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

/* 帧序号读数：优先找舞台内的 [data-frame]，兼容旧版放在舞台父级里的写法 */
const findFrameLabel = (view) =>
  view.querySelector('[data-frame]') ?? view.parentElement?.querySelector('[data-frame]') ?? null;

/* 收集阶段：先把所有渲染器建好，再统一绑指针。
   否则「先绑 A、指针移到 B 时 B 的渲染器还没建」会出现短暂无声区。 */
const views = document.querySelectorAll('[data-sprite-view]');
const mounted = [];
let anchor = null; // 视差的归一化基准；默认第一个可驱动舞台

for (const view of views) {
  const target = view.querySelector('[data-sprite]');
  const frameCount = readNumber(view.dataset.frameCount);
  const columns = readNumber(view.dataset.columns);
  const rows = readNumber(view.dataset.rows);

  /* 分段路径（121 帧）：data-segments 为构建时静态注入的段清单 JSON。
     资源本身（WebP 文件）运行时按需加载——与 <img> 加载图片同性质，
     「零 fetch」契约针对的是参数数据（atlas-meta），不受影响。 */
  let segments = null;
  if (view.dataset.segments) {
    try {
      segments = JSON.parse(view.dataset.segments);
    } catch {
      console.warn('[motion] data-segments JSON 非法，回退单图路径：', view.id || view);
    }
  }

  const cellWidth = readNumber(view.dataset.cellWidth);
  const cellHeight = readNumber(view.dataset.cellHeight);

  if (!target || !frameCount || (segments && (!cellWidth || !cellHeight)) || (!segments && (!view.dataset.asset || !columns || !rows))) {
    console.warn('[motion] 舞台缺少必需属性，已跳过：', view.id || view);
    continue;
  }

  const renderer = segments
    ? createSegmentedSpriteRenderer({
        target,
        frameLabel: findFrameLabel(view),
        segments,
        frameCount,
        cellWidth,
        cellHeight,
      })
    : createSpriteRenderer({
        target,
        frameLabel: findFrameLabel(view),
        asset: view.dataset.asset,
        frameCount,
        columns,
        rows,
      });

  const animator = createFrameAnimator({
    frameCount,
    render: (frame) => renderer.render(frame),
  });

  const entry = {
    view,
    target,
    animator,
    frameCount, // 供触摸定格帧换算 progress：frame / (frameCount - 1)
    insets: readInsets(view.dataset.personInset),
    warp: parseFrameWarp(view.dataset.frameWarp, frameCount),
    personRect: null, // 本舞台自己的死区矩形
    spans: null, // 本舞台自己的象限可达角度
  };
  mounted.push(entry);

  // 视差锚点：显式标注 data-follow-anchor 的舞台优先，否则取第一个可驱动舞台
  if (!anchor || view.hasAttribute('data-follow-anchor')) anchor = entry;
}

/* 几何缓存。
   每次 pointermove 都调 getBoundingClientRect，会在「读几何 → 写 background-position」
   之间强制同步重排；改为在几何可能变化的时机失效重算。
   舞台矩形只给视差用；每个舞台的帧随动各用自己的人物图片区域矩形。 */
let stageRect = null;

/* 元素盒按"左 上 右 下"四个分数内缩，得到人物图片区域矩形 */
const insetRect = (box, [l, t, r, b]) => ({
  left: box.left + box.width * l,
  top: box.top + box.height * t,
  width: box.width * (1 - l - r),
  height: box.height * (1 - t - b),
});

const measure = () => {
  if (anchor) {
    const s = anchor.view.getBoundingClientRect();
    stageRect =
      s.width > 0 && s.height > 0
        ? { left: s.left, top: s.top, width: s.width, height: s.height }
        : null;
  }
  const page = viewportRect();
  for (const m of mounted) {
    const f = m.target.getBoundingClientRect();
    m.personRect =
      f.width > 0 && f.height > 0
        ? insetRect({ left: f.left, top: f.top, width: f.width, height: f.height }, m.insets)
        : null;
    // 象限可达角度只跟两个矩形有关，几何一变就重算（720 步 × 4 象限，代价可忽略）
    m.spans = m.personRect ? reachableSpans(m.personRect, page) : null;
  }
};

/* 逐舞台推进帧序号。舞台自己的矩形还没量到（display:none 等）时保持第 0 帧。
   触摸定格帧（pinnedFrame）优先于角度映射：移动端点卡片时人物直接转向
   该卡指定的姿态帧，缓动与切图仍走同一个 animator/renderer（雪碧图定位），
   不经过 warp 重定时——卡片配比就是素材里的真实帧号。 */
let pinnedFrame = null;

/* ── 触摸点卡：先看姿态，再进卡片（2026-09-11 用户指定，仅触摸路径）──────
 * 卡片变成真链接后，移动端点击会立刻跳走，pointerdown 里的定格姿态来不及看。
 * 约定：触摸点卡 → 定格照常 → click 被拦截，延时 NAV_DELAY 再跳转；
 * 跳转前把帧号写进 sessionStorage，从板块页返回首页时若期间没有触其他位置，
 * 人物初始就定格回该卡姿态。触其他任何位置 = 取消未决跳转 + 回首帧 + 清存储
 * （原有语义不变，只是顺带清状态）。鼠标与键盘激活（Enter）完全不走这条路。
 * 延时按行程自适应：定格帧离正面越远，转身要的时间越长。
 *   延时 ≈ |frame| ÷ (frameCount×2 帧/s) + 140ms 余量
 * （maxSpeed 与 motion.js 的 createFrameAnimator 同式 = frameCount×2）。
 * 实测换算：f4→~185ms、f14→~290ms、f19→~350ms、f30→~465ms——
 * 近卡跟手，远卡姿态转完再进（用户 2026-09-11 反馈 0.5s 一刀切偏久）。 */
const NAV_DELAY_MARGIN = 140;
const PIN_KEY = 'daidai:pinned-frame';
let lastPointerType = ''; // click 事件拿不到可靠的 pointerType，用最近一次 pointerdown 的
let pendingNav = null; // { href, timer }

const navDelayFor = (frame) => {
  const count = anchor?.frameCount ?? 0;
  if (count < 2) return 350;
  return Math.round((frame / (count * 2)) * 1000) + NAV_DELAY_MARGIN;
};

const cancelPendingNav = () => {
  if (pendingNav) {
    clearTimeout(pendingNav.timer);
    pendingNav = null;
  }
};

const clearPinnedState = () => {
  pinnedFrame = null;
  try {
    sessionStorage.removeItem(PIN_KEY);
  } catch {
    /* 隐私模式等拿不到 sessionStorage 就算了，跳转后不复原姿态而已 */
  }
};

function applyProgress() {
  /* 滚动 scrub 接管期间（scroll-scrub.js 置 documentElement.dataset.scrub="on"）
     冻结 hero 姿态：两套素材不是连续动作，指针映射此刻无意义；
     退出 scrub 的时机由 scrub 模块在倒回 f0 时决定。 */
  if (document.documentElement.dataset.scrub === 'on') return;
  /* 档案抽屉（#basic dialog）打开期间同样冻结（2026-09-13）：指针在 overlay
     上移动不该让背板后的人物转头；data-file-open 由 BasicDrawer 开关时维护 */
  if (document.documentElement.dataset.fileOpen !== undefined) return;
  for (const m of mounted) {
    let p;
    if (pinnedFrame != null && m.frameCount > 1) {
      /* 触摸点卡：定格到卡片配帧 */
      p = clamp01(pinnedFrame / (m.frameCount - 1));
    } else if (pointer.active && m.personRect && (!pointer.type || pointer.type === 'mouse')) {
      /* 鼠标：360° 圆环角度映射（含 warp 重定时） */
      p = progressFromPointer({
        x: pointer.x,
        y: pointer.y,
        rect: m.personRect,
        spans: m.spans,
        warp: m.warp,
      });
    } else {
      /* 触摸未点卡：回首帧 */
      p = 0;
    }
    m.animator.setProgress(p);
    if (m === anchor) state.progress = p;
  }
}

if (anchor) {
  measure();
  // 字体/背景图落位后人物尺寸可能变，补测一次
  if (document.fonts?.ready) document.fonts.ready.then(measure);
  window.addEventListener('resize', measure, { passive: true });
  window.addEventListener('scroll', measure, { passive: true, capture: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(measure);
    for (const m of mounted) {
      ro.observe(m.view);
      ro.observe(m.target);
    }
  }
}

/* 指针作用域是整个文档，不是舞台盒子。
   人物矩形的方向角才是坐标系，舞台只决定视差的比例基准——
   指针在视口四角（舞台之外或被卡片压住的区域）时仍然应该跟随。 */
/* 触摸/笔点到带 data-look-frame 的卡片 → 定格到该帧；点到其他位置 →
   解除定格，回到方向角映射（"触摸哪里看哪里"）。鼠标一律不参与定格——
   桌面的悬停跟随手感是调好的，不因点击卡片而改变（2026-09-11 用户指定）。 */
const lookFrameFrom = (event) => {
  const el =
    event.target instanceof Element ? event.target.closest('[data-look-frame]') : null;
  if (!el) return null;
  const frame = Number.parseInt(el.getAttribute('data-look-frame') ?? '', 10);
  return Number.isFinite(frame) && frame >= 0 ? frame : null;
};

const handlePointer = (event) => {
  if (event.type === 'pointerdown' && event.pointerType !== 'mouse') {
    /* 任何触摸落下都先撤掉未决跳转：点的是同一张卡也没关系，
       随后的 click 会重新排程（相当于重置 500ms 倒计时）。 */
    cancelPendingNav();
    if (lookFrameFrom(event)) {
      pinnedFrame = lookFrameFrom(event);
    } else {
      /* 触其他位置 = 回首帧，同时清掉"返回后复原"的状态 */
      clearPinnedState();
    }
  }
  if (event.type === 'pointerdown') lastPointerType = event.pointerType ?? '';
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.type = event.pointerType ?? '';
  pointer.active = true;
  if (!stageRect) measure();
  if (!stageRect) return;
  emit({
    x: (event.clientX - stageRect.left) / stageRect.width,
    y: (event.clientY - stageRect.top) / stageRect.height,
  });
};

window.addEventListener('pointermove', handlePointer, { passive: true });
window.addEventListener('pointerdown', handlePointer, { passive: true });

/* 指针离开文档（鼠标移出窗口 / 切到别的 app）才归位：
   帧回到第 0 帧的正面姿态，视差回到中点（卡片无位移）。
   注意是 documentElement 的 pointerleave —— 只在指针离开视口时触发；
   挂在舞台上的话一移出舞台就触发，正是早前"移到页面角落不跟随"的来源。
   触摸/笔是瞬态指针：抬起后浏览器立即派发 pointerout/pointerleave，
   若跟着复位，点一下卡片就会"冲向卡片又弹回第 0 帧"（2026-09-11 用户报告）。
   所以只有鼠标离开才归位；触摸/笔保持最后的姿态，直到下一次触摸改目标。 */
document.documentElement.addEventListener('pointerleave', (event) => {
  if (event.pointerType && event.pointerType !== 'mouse') return;
  pointer.active = false;
  emit({ x: 0.5, y: 0.5 });
});

/* 触摸点卡的延时跳转：只拦"最近一次按下是触摸/笔"的卡片点击；
   鼠标与键盘激活（lastPointerType 为空 = 没有 pointerdown，键盘 Enter）
   直接 return，走浏览器默认导航，桌面手感与可访问性都不动。
   只拦站内页路由（href 以 / 开头）：#basic 这类本页锚点延时会显得迟钝，
   保持默认即时滚动，姿态定格仍由 pointerdown 负责。 */
window.addEventListener('click', (event) => {
  if (lastPointerType === 'mouse' || lastPointerType === '') return;
  if (!(event.target instanceof Element)) return;
  const card = event.target.closest('[data-look-frame]');
  if (!card) return;
  const href = card.getAttribute('href') ?? '';
  if (!href.startsWith('/')) return;
  if (event.defaultPrevented) return;
  event.preventDefault();
  try {
    sessionStorage.setItem(PIN_KEY, String(pinnedFrame ?? 0));
  } catch {
    /* 同上，写不进就放弃"返回复原"，跳转本身不受影响 */
  }
  pendingNav = {
    href,
    timer: setTimeout(() => {
      pendingNav = null;
      window.location.href = href;
    }, navDelayFor(pinnedFrame ?? 0)),
  };
});

/* 返回首页时的姿态复原（仅触摸设备）：sessionStorage 里存着上一次
   触摸点卡的帧号，且用户返回后还没触过任何位置（一旦触了，上面
   pointerdown 分支会清掉存储）→ 人物初始就定格回那张卡片的姿态。
   只有触摸路径会写这个键，桌面载入天然不受影响；再叠一层
   pointer:coarse 守卫，防"手机用过之后换桌面继续用同一标签页"的串味。 */
try {
  if (
    pinnedFrame == null &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches
  ) {
    const stored = Number.parseInt(sessionStorage.getItem(PIN_KEY) ?? '', 10);
    if (Number.isFinite(stored) && stored >= 0) pinnedFrame = stored;
  }
} catch {
  /* sessionStorage 不可用就当没有这个状态 */
}

/* 卡片视差：景深由页面的 data-depth 给出，脚本不假设版式几何 */
const cards = document.querySelectorAll('[data-depth]');
if (cards.length) {
  const parallax = createCardParallax({ cards: Array.from(cards) });
  subscribers.push((payload) => parallax.update(payload));
}

/* 全部就绪后广播一次，让所有订阅者从同一起点开始 */
emit({});
