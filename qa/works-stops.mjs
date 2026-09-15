// /works/ 轨道停靠契约回归（纯 Node，无浏览器）。
//
// 背景：2026-09-15 v4 定稿模型（works-view.js 文件头「停靠点模型 v4」）：
//   stops = [intro, set0..setN, end]：
//     - intro  = 初始态：首卡中心钉在视口右缘（恰好露出左半边）；
//     - 组 k 停靠 = times[k+1]（raw/times 自 v3 起整体右移一位）；
//     - end    = 「完」卡（.endcard 包裹层）居中，progress=1 即触底（无 endFly）。
//   首段 [intro → 组0] 滚动消耗按 INTRO_BUDGET 压缩——max 是滚动空间而非轨道
//   里程，renderCascade 内做 pos→progress 分段换算；每段三拍 = 飞入期(FLY) +
//   空转停顿(IDLE，自本组末卡**实际落位点**起算 = 动态 goAt) + 过渡；
//   「完」卡飞入并入 [末组 → end] 过渡期（v3 的 endFly 虚拟站已删）。
// 本脚本把以下契约锁成回归：
//
//   - 不起浏览器：用 DOM 桩镜像 works-rail.css 的布局公式与 works-view.js
//     的几何/编排常量，导入真实的 src/lib/works-view.js（其内部 import 真实的
//     works-rail.js），用虚拟 requestAnimationFrame 驱动滚轮输入到收敛。
//   - 卡数不硬编码：运行时从 profile.json 按 works.astro 的建组公式推导
//     （作品数 + 空类目空态卡 + 封面卡），数据增删不再使本文件过期。
//   - 断言契约：
//       A1  首屏 intro 停靠：首卡中心钉视口右缘、卡 0 立即可见(x=0, scale=1)、
//           卡 1/2 隐藏、提示可见；
//       A2  各组停靠居中（progress = times[k+1]）；组 0 到站时首卡已收小到
//           targetScale（intro 段缩放契约，63c013a）；
//       A3  组 1 飞入期中间态：卡 0 已就位、卡 1 飞行途中、轨道钉住；
//       A3e 组 1 飞入期结束（sp=FLY）：满扇（此时轨道已起步，不查居中）；
//       A3f 组 1 空转停顿期（动态 goAt 窗口中点）：轨道钉住、扇形保持；
//       A4  end 停靠：「完」卡居中且自身已飞入就位（translateX(0), opacity 1）；
//       A5  首屏提示：组 0 到站（times[1]）时淡出完毕；
//       A6  过渡期：下一组空白滑入（opacity 0），当前组满扇被推走；
//       A7  倒放可逆：倒滚到组 2 飞入中点呈中间态，倒滚到到站点呈空白；
//       A8  快滚直达终点：跳过全部中间拍，末组仍满扇、endcard 可见；
//       A9  进度持久化：滚到组 1 停靠 → destroy（模拟跳转离开）→ 重新挂载
//           （模拟返回重载）→ 直接恢复，无需重滚（2026-09-15 用户报告：
//           「点卡片出去再回来，要重新滑到之前的位置」）。
//
// 运行：node qa/works-stops.mjs   （exit 0 = 全绿 / 1 = 有断言失败）
// 改 works-view.js 的几何或编排、改 works-rail.css 的卡宽/间隙后必须跑。

// ── DOM 桩 ──────────────────────────────────────────────────────────────
const rafQ = [];
let vt = 0;
globalThis.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
globalThis.cancelAnimationFrame = () => {};

function pump(maxFrames = 500) {
  for (let n = 0; n < maxFrames && rafQ.length; n++) {
    const q = rafQ.splice(0); // ⚠️ 必须拷贝取出：alias 后 length=0 会把队列清空
    vt += 16;
    for (const cb of q) cb(vt);
  }
  if (rafQ.length) throw new Error('rAF 未收敛（>500 帧）');
}

const windowObj = new EventTarget();
windowObj.matchMedia = () => ({ matches: false });
windowObj.innerWidth = 1280;
windowObj.innerHeight = 800;
globalThis.window = windowObj;

// 内存版 sessionStorage：验证进度持久化（A9）。⚠️ 必须含 removeItem——
// persistGuard 判「板块外进入」时靠它清除残留进度，桩缺了它清除会静默失败
const memStore = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => memStore.set(k, String(v)),
  removeItem: (k) => memStore.delete(k),
};

// ── 布局模型：必须与 works-rail.css 的公式逐字同步 ────────────────────────
const vw = 1280;
const clampN = (v, a, b) => Math.max(a, Math.min(v, b)); // CSS clamp(MIN, VAL, MAX)
const PAD = clampN(0.08 * vw, 20, 110);        // .stack-rail padding-inline
const CARD_W = clampN(0.45 * vw, Math.min(760, 0.92 * vw), 920); // --card-w（审计 A1 公式）
const GAP = clampN(0.14 * vw, 48, 180);        // .set-gap width（14vw，与 CSS 同步）
const END_PAD = clampN(0.06 * vw, 40, 80);     // .end-set padding-left
const END_W = CARD_W;                          // .endcard-face width = var(--card-w)（v4 整卡）

// 卡数：与 works.astro 的建组公式同源（勿硬编码——profile.json 变更不再打爆本文件）
const profileData = (await import('../src/data/profile.json', { with: { type: 'json' } })).default;
const CATS = profileData.works.cats.filter((c) => c.id !== 'inbox'); // inbox 不建组
const ITEMS = profileData.works.items;
const CARD_COUNTS = CATS.map((cat) => {
  const n = ITEMS.filter((w) => w.cat === cat.id).length;
  return n + (n === 0 ? 1 : 0) + (cat.img ? 1 : 0); // 作品 + 空类目空态卡 + 封面
});

const setLefts = [];
{ let x = PAD; for (let i = 0; i < CARD_COUNTS.length; i++) { setLefts.push(x); x += CARD_W + GAP; } }
const endSetLeft = setLefts[setLefts.length - 1] + CARD_W + GAP; // 末组后有 set-gap（「完」卡与其他组同构）
const faceLeft = endSetLeft + END_PAD;

// ── 几何/编排常量：必须与 works-view.js 逐字同步 ─────────────────────────
const FLY = 0.5;
const IDLE = 0.08;
const STAG = 0.25;
const FLY_WIN = 0.35;
const INTRO_BUDGET = 0.42;
const HINT_FADE = 0.8;

// 镜像 works-view.js geometry()：stops = [intro, set0..setN, end]
const introCenter = setLefts[0] + CARD_W / 2 - vw; // 首卡中心钉视口右缘（露左半边）
const setCenters = setLefts.map((l) => l - (vw - CARD_W) / 2);
const endCenter = faceLeft - (vw - END_W) / 2;
const centers = [introCenter, ...setCenters, endCenter];
const origin = centers[0];
const norm = centers.map((c) => c - origin);
const lastNorm = norm[norm.length - 1];
const times = norm.map((v) => v / lastNorm);       // 组 k 到站 = times[k+1]

// 滚动空间（stackMax）与 pos↔progress 分段换算（renderCascade 消费同一公式）
const introRail = norm[1];
const introScroll = introRail * INTRO_BUDGET;
const stackMax = lastNorm - introRail * (1 - INTRO_BUDGET);
const progressAt = (pos) =>
  pos <= introScroll
    ? times[1] * (introScroll > 0 ? Math.min(Math.max(pos / introScroll, 0), 1) : 1)
    : times[1] + Math.min(Math.max((pos - introScroll) / (stackMax - introScroll), 0), 1) * (1 - times[1]);
const posAt = (p) =>
  p <= times[1]
    ? introScroll * (p / times[1])
    : introScroll + ((p - times[1]) / (1 - times[1])) * (stackMax - introScroll);

// 动态 goAt（renderCascade）：段 [组k → 组k+1] 内，组 k 末卡落位 + IDLE
const goAtOf = (n) => Math.min(FLY * Math.min((n - 1) * STAG + FLY_WIN, 1) + IDLE, 1);

// ── 元素桩 ───────────────────────────────────────────────────────────────
const mkEl = (props = {}) => ({ dataset: {}, style: {}, addEventListener() {}, ...props });
const viewport = mkEl({ clientWidth: vw });
const rail = mkEl({});
const hint = mkEl({});
const ruler = mkEl({ clientWidth: 200 });
const frame = mkEl({ offsetWidth: 22 });
const cardSets = CARD_COUNTS.map((count, i) => {
  const cards = Array.from({ length: count }, () => mkEl({}));
  return mkEl({ offsetLeft: setLefts[i], offsetWidth: CARD_W, querySelectorAll: (sel) => (sel === '.stack-card' ? cards : []) });
});
// 「完」卡：works-view.js 测 .endcard（<a> 包裹层）而非 .endcard-face
//（offsetParent 沿包含块链走，face 的参照物是带 will-change 的 .endcard，
//  2026-09-15 事故：测 face 读数 ≈0、times 全盘错乱）
const endcard = mkEl({ offsetLeft: faceLeft, offsetWidth: END_W });
const endSet = mkEl({ querySelector: (sel) => (sel === '.endcard' ? endcard : null) });

globalThis.document = {
  documentElement: { scrollHeight: 0 },
  fonts: { ready: Promise.resolve() },
  querySelector: (sel) =>
    ({ '[data-stack-viewport]': viewport, '[data-stack-rail]': rail, '[data-scroll-hint]': hint, '[data-ruler]': ruler, '[data-frame]': frame, '.end-set': endSet, '.end-set .endcard': endcard }[sel] ?? null),
  querySelectorAll: (sel) => (sel === '.card-set' ? cardSets : []),
};

// ── 挂载真实模块 ─────────────────────────────────────────────────────────
const { mountWorksRail } = await import('../src/lib/works-view.js');
let railApi = mountWorksRail();
pump(); // 消化 measure() 里可能排队的补测帧

// ── 驱动 + 断言 ──────────────────────────────────────────────────────────
let cur = 0;
function goToPx(px) {
  windowObj.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: (px - cur) * 3 }));
  cur = px;
  pump();
}
// 注意：滚轮输入改的是「滚动空间 pos」，不是轨道里程——目标进度 p 须经
// posAt 反解成滚动空间 px（INTRO_BUDGET 分段换算的逆运算）
const goToProgress = (p) => goToPx(posAt(p));

const railX = () => parseFloat(/translate3d\((-?[\d.]+)px/.exec(rail.style.transform)?.[1] ?? 'NaN');
const cardX = (c) => parseFloat(/translateX\((-?[\d.]+)%\)/.exec(c.style.transform)?.[1] ?? 'NaN');
const cardOpacity = (c) => c.style.opacity;
const cardsOf = (k) => cardSets[k].querySelectorAll('.stack-card');
const setLeftOnScreen = (k) => setLefts[k] + railX();

const fails = [];
function check(name, ok, detail) {
  if (!ok) fails.push(`${name}  ←  ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// A1 首屏：intro 停靠（首卡中心钉视口右缘）+ 卡 0 立即可见 + 卡 1/2 隐藏 + 提示可见
{
  const firstCenter = setLeftOnScreen(0) + CARD_W / 2;
  check('A1 首屏 intro 停靠：首卡中心钉视口右缘', near(firstCenter, vw), `center=${firstCenter.toFixed(1)} 期望 ${vw}`);
  const [c0, c1, c2] = cardsOf(0);
  check('A1b 首屏卡 0 立即可见 x=0', cardOpacity(c0) === '1' && near(cardX(c0), 0, 0.5), `opacity=${cardOpacity(c0)} x=${cardX(c0)}`);
  check('A1c 首屏卡 0 满幅 scale(1)', /scale\(1\)/.test(c0.style.transform), `transform=${c0.style.transform}`);
  check('A1d 首屏卡 1/2 隐藏', cardOpacity(c1) === '0' && cardOpacity(c2) === '0', `op1=${cardOpacity(c1)} op2=${cardOpacity(c2)}`);
  check('A1e 首屏提示可见', hint.style.opacity === '1', `opacity=${hint.style.opacity}`);
}

// A2 各组停靠居中（组 k 到站 = times[k+1]）；组 0 到站时首卡已收小到 targetScale
for (let k = 0; k < setLefts.length; k++) {
  goToProgress(times[k + 1]);
  check(`A2 组${k} 停靠居中`, near(setLeftOnScreen(k), (vw - CARD_W) / 2), `left=${setLeftOnScreen(k).toFixed(1)} 期望 ${(vw - CARD_W) / 2}`);
  if (k === 0) {
    const s0 = parseFloat(/scale\(([\d.]+)\)/.exec(cardsOf(0)[0].style.transform)?.[1] ?? 'NaN');
    check('A2b 组0 到站首卡收小到 targetScale=0.9', near(s0, 0.9, 0.02), `scale=${s0}`);
  }
}

// A3 组 1（engine，n=2）飞入期中间态（sp=0.24 → flyP=0.48）：卡 0 就位、卡 1 途中、轨道钉住
// ⚠️ 进度点避开 flyP=0.25（卡 1 起飞点）：reveal>0 的可见性判断在浮点边界上会抖动
{
  const seg = times[3] - times[2];
  goToProgress(times[2] + 0.24 * seg);
  const [c0, c1] = cardsOf(1);
  check('A3 组1 飞入中卡 0 就位', near(cardX(c0), 0, 0.5) && cardOpacity(c0) === '1', `x=${cardX(c0)} op=${cardOpacity(c0)}`);
  const x1 = cardX(c1);
  check('A3b 组1 飞入中卡 1 途中', x1 > 10 && x1 < 80 && cardOpacity(c1) === '1', `x=${x1} op=${cardOpacity(c1)}`);
  check('A3c 组1 飞入期钉在中心（sp<goAt）', near(setLeftOnScreen(1), (vw - CARD_W) / 2), `left=${setLeftOnScreen(1).toFixed(1)}`);
}

// A3e 组 1 飞入期结束（sp=FLY）：满扇。此时 sp>goAt、轨道已起步，不查居中
{
  const seg = times[3] - times[2];
  goToProgress(times[2] + FLY * seg);
  cardsOf(1).forEach((c, i) => {
    check(`A3e 组1 飞入完成卡${i} 满扇 x=${i * 10}%`, near(cardX(c), i * 10, 1.5) && cardOpacity(c) === '1', `x=${cardX(c)} op=${cardOpacity(c)}`);
  });
}

// A3f 组 1 空转停顿期（动态 goAt 窗口 [spLand, goAt] 中点）：轨道钉住、扇形保持
{
  const seg = times[3] - times[2];
  const goAt = goAtOf(CARD_COUNTS[1]); // n=2 → 0.38
  const spLand = goAt - IDLE;          // 末卡实际落位点（FLY×0.6=0.30）
  goToProgress(times[2] + (spLand + IDLE / 2) * seg);
  check('A3f 组1 空转期钉在中心', near(setLeftOnScreen(1), (vw - CARD_W) / 2), `left=${setLeftOnScreen(1).toFixed(1)}`);
  const cover = cardsOf(1).at(-1);
  check('A3g 组1 空转期扇形保持', near(cardX(cover), 10, 1.5) && cardOpacity(cover) === '1', `x=${cardX(cover)} op=${cardOpacity(cover)}`);
}

// A4 end：完卡居中（v4 整卡 = END_W）且自身已飞入就位（与轨道同时完成）
goToProgress(1);
check('A4 完卡居中', near(faceLeft + railX(), (vw - END_W) / 2), `left=${(faceLeft + railX()).toFixed(1)} 期望 ${(vw - END_W) / 2}`);
check('A4b 完卡飞入就位 translateX(0)', cardOpacity(endcard) === '1' && near(cardX(endcard), 0, 0.5), `op=${cardOpacity(endcard)} x=${cardX(endcard)}`);

// A5 提示淡出：组 0 到站（times[1]）时 opacity≈0（HINT_FADE=0.8 < 1）
goToProgress(times[1]);
check('A5 组0 到站提示已淡出', parseFloat(hint.style.opacity) <= 0.05, `opacity=${hint.style.opacity}`);

// A6 过渡期：下一组空白滑入（opacity 0），当前组满扇被推走
{
  const seg = times[2] - times[1];
  const goAt0 = goAtOf(CARD_COUNTS[0]); // 组0 n=3 → 0.505
  goToProgress(times[1] + (goAt0 + 0.5 * (1 - goAt0)) * seg); // 过渡中点（t=0.5）
  check('A6a 过渡中组 1 空白', cardsOf(1).every((c) => cardOpacity(c) === '0'), `ops=${cardsOf(1).map(cardOpacity).join(',')}`);
  const expected = [0, 10, 20];
  check('A6b 过渡中组 0 满扇', cardsOf(0).every((c, i) => cardOpacity(c) === '1' && near(cardX(c), expected[i], 1.5)), `ops=${cardsOf(0).map(cardOpacity).join(',')}`);
}

// A7 倒放可逆：倒滚到组 2 飞入中点呈中间态，倒滚到到站点呈空白（HEAD 语义）
// 组 2（app）与组 1 同为 n=2，断言卡 0/卡 1
{
  const seg = times[4] - times[3];
  goToProgress(times[3] + 0.24 * seg); // 组 2 飞入期中段
  const [c0, c1] = cardsOf(2);
  check('A7a 倒滚组 2 飞入中态', near(cardX(c0), 0, 0.5) && cardOpacity(c0) === '1' && cardOpacity(c1) === '1' && cardX(c1) > 10 && cardX(c1) < 80, `x0=${cardX(c0)} op0=${cardOpacity(c0)} x1=${cardX(c1)} op1=${cardOpacity(c1)}`);
  // ⚠️ 到站点回退 1e-9：posAt 反解经模块正向换算后可能落在 times[k]+ε（浮点
  // 噪声），卡 0 的 reveal=flyP/FLY_WIN>0 会被判可见（与 A3 注释同款边界抖动，
  // 恰落在卡 0 起飞点上）。设计的纯函数语义 = progress ≤ 到站点整组空白，
  // 断言贴下方一侧（与真实倒滚的连续行为一致）；1e-9 远大于 float 噪声
  // （~1e-13）、远小于视觉容差（2px ÷ 4000px 里程 ≈ 5e-4）。
  goToProgress(times[3] - 1e-9); // 组 2 到站：整组空白（尚未飞入）
  check('A7b 倒滚组 2 到站空白', cardsOf(2).every((c) => cardOpacity(c) === '0'), `ops=${cardsOf(2).map(cardOpacity).join(',')}`);
  goToProgress(times[2] - 1e-9); // 组 1 到站：同样空白
  check('A7c 倒滚组 1 到站空白', cardsOf(1).every((c) => cardOpacity(c) === '0'), `ops=${cardsOf(1).map(cardOpacity).join(',')}`);
}

// A8 快滚直达终点：跳过全部中间拍，末组仍满扇、endcard 可见
{
  goToProgress(1);
  cardsOf(3).forEach((c, i) => {
    check(`A8 直达终点组 3 卡${i} 满扇 x=${i * 10}%`, near(cardX(c), i * 10, 1.5) && cardOpacity(c) === '1', `x=${cardX(c)} op=${cardOpacity(c)}`);
  });
  check('A8b 直达终点完卡可见', cardOpacity(endcard) === '1', `op=${cardOpacity(endcard)}`);
}

// A9 进度持久化：滚到组 1 停靠 → 销毁实例（模拟跳转离开）→ 重新挂载
//（模拟返回重载）→ 直接恢复到组 1，无需重新滚动（2026-09-15 用户报告）。
// A9c/A9d（2026-09-15 用户裁定「恢复只认板块内往返」）：从板块外（首页）
// 点进来 = 回到初始态（首图），且已存进度被清除。来源判据 = referrer
// 是否含 /works/（详情页返回）+ Navigation Timing 的 back_forward/reload。
{
  goToProgress(times[2]); // 旧实例滚到组 1 停靠：输入点已把 target 写入 sessionStorage
  const savedPx = Number(memStore.get('works-rail:works'));
  check('A9a 离开时进度已写入', near(savedPx, posAt(times[2]), 2), `saved=${savedPx} 期望 ${posAt(times[2]).toFixed(1)}`);
  railApi.destroy(); // 模拟跳转离开（页面卸载）
  globalThis.document.referrer = 'http://localhost/works/01/'; // 模拟从详情页返回
  railApi = mountWorksRail(); // 模拟返回重载（重新初始化，读回进度）
  pump();
  check('A9b 详情页返回恢复到组 1 停靠', near(setLeftOnScreen(1), (vw - CARD_W) / 2), `left=${setLeftOnScreen(1).toFixed(1)} 期望 ${(vw - CARD_W) / 2}`);
  railApi.destroy();
  globalThis.document.referrer = 'http://localhost/'; // 模拟从首页点击进入（板块外）
  railApi = mountWorksRail();
  pump();
  check('A9c 板块外进入回到初始态（首图）', near(setLeftOnScreen(0) + CARD_W / 2, vw), `center=${(setLeftOnScreen(0) + CARD_W / 2).toFixed(1)} 期望 ${vw}`);
  check('A9d 板块外进入已清除存储', memStore.get('works-rail:works') == null, `saved=${memStore.get('works-rail:works')}`);
}

console.log(fails.length ? `\n${fails.length} 项断言失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
