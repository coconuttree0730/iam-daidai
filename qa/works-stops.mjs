// /works/ 轨道停靠契约回归（纯 Node，无浏览器）。
//
// 背景：2026-09-14 晚改版引入 stops 模型（intro/set0..N/end + 行程权重时间轴）
// 后，用户报告「折叠堆叠卡片形态消失、平铺成一排、完卡不作为独立停靠」。
// 根因见 works-view.js 内注释（渲染位移符号取反）。本脚本把该事故锁成回归：
//
//   - 不起浏览器：用 DOM 桩镜像 works-rail.css 的布局公式，导入真实的
//     src/lib/works-view.js（其内部 import 真实的 works-rail.js），
//     用虚拟 requestAnimationFrame 驱动滚轮输入到收敛。
//   - 断言契约：
//       A1 intro 停靠：首卡右缘贴视口右缘（vw-40），轨道整体右移；
//       A2 各组停靠：组居中（on-screen 左缘 = (vw-卡宽)/2）；
//       A3 停留期 3/4 处：组内卡片完全展开成扇（x = i*cardGap%）且可见；
//       A4 end 停靠：「完」牌面居中（独立整体，单独到站）；
//       A5 首屏提示：intro 时 opacity=1，首组到站时淡出完毕；
//       A6 组 k>0 到站前整组隐藏（不抢镜）。
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
windowObj.innerHeight = 800;
globalThis.window = windowObj;

// ── 布局模型：必须与 works-rail.css 的公式逐字同步 ────────────────────────
const vw = 1280;
const clampN = (v, a, b) => Math.min(Math.max(v, a), b);
const PAD = clampN(0.08 * vw, 20, 110);        // .stack-rail padding-inline
const CARD_W = clampN(0.45 * vw, 760, 920);    // .card-set width（--card-w）
const GAP = clampN(0.07 * vw, 48, 110);        // .set-gap width
const END_PAD = clampN(0.06 * vw, 40, 80);     // .end-set padding-left
const FACE_W = clampN(0.20 * vw, 180, 230);    // .endcard-face width

// 真实数据（profile.json works）：site/engine/app/craft，卡数 = 作品数 + 封面
const CARD_COUNTS = [3, 3, 2, 3];

const setLefts = [];
{ let x = PAD; for (let i = 0; i < CARD_COUNTS.length; i++) { setLefts.push(x); x += CARD_W + GAP; } }
const endSetLeft = setLefts[setLefts.length - 1] + CARD_W; // 末组后无 set-gap
const faceLeft = endSetLeft + END_PAD;

// 镜像 works-view.js geometry() 的停靠点公式
const TRANS = 0.3;
const setCenters = setLefts.map((l) => l - (vw - CARD_W) / 2);
const endCenter = faceLeft - (vw - FACE_W) / 2;
const introCenter = setLefts[0] - (vw - CARD_W - 40); // INTRO_RIGHT_PAD=40（桌面）
const centers = [introCenter, ...setCenters, endCenter];
const origin = centers[0];
const norm = centers.map((c) => c - origin);
const lastNorm = norm[norm.length - 1];
const times = norm.map((v) => v / lastNorm);

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
const endSet = mkEl({ querySelector: (sel) => (sel === '.endcard-face' ? face : null) });
const face = mkEl({ offsetLeft: faceLeft, offsetWidth: FACE_W });

globalThis.document = {
  documentElement: { scrollHeight: 0 },
  fonts: { ready: Promise.resolve() },
  querySelector: (sel) =>
    ({ '[data-stack-viewport]': viewport, '[data-stack-rail]': rail, '[data-scroll-hint]': hint, '[data-ruler]': ruler, '[data-frame]': frame, '.end-set': endSet }[sel] ?? null),
  querySelectorAll: (sel) => (sel === '.card-set' ? cardSets : []),
};

// ── 挂载真实模块 ─────────────────────────────────────────────────────────
const { mountWorksRail } = await import('../src/lib/works-view.js');
mountWorksRail();
pump(); // 消化 measure() 里可能排队的补测帧

// ── 驱动 + 断言 ──────────────────────────────────────────────────────────
let cur = 0;
function goToPx(px) {
  windowObj.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: (px - cur) * 3 }));
  cur = px;
  pump();
}
const goToProgress = (p) => goToPx(p * lastNorm);

const railX = () => parseFloat(/translate3d\((-?[\d.]+)px/.exec(rail.style.transform)?.[1] ?? 'NaN');
const cardX = (c) => parseFloat(/translateX\((-?[\d.]+)%\)/.exec(c.style.transform)?.[1] ?? 'NaN');
const cardOpacity = (c) => c.style.opacity;

const fails = [];
function check(name, ok, detail) {
  if (!ok) fails.push(`${name}  ←  ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// A1 intro：轨道右移，首卡右缘 = vw - 40
const onScreenRight0 = setLefts[0] + railX() + CARD_W;
check('A1 intro 首卡右缘贴视口右缘', near(onScreenRight0, vw - 40), `right=${onScreenRight0.toFixed(1)} 期望 ${vw - 40}`);
check('A1b intro 首组堆叠态可见', cardOpacity(cardSets[0].querySelectorAll('.stack-card')[0]) === '1' && near(cardX(cardSets[0].querySelectorAll('.stack-card')[0]), 0, 0.5), `opacity=${cardOpacity(cardSets[0].querySelectorAll('.stack-card')[0])} x=${cardX(cardSets[0].querySelectorAll('.stack-card')[0])}`);
check('A1c intro 提示可见', hint.style.opacity === '1', `opacity=${hint.style.opacity}`);

// A2 各组居中
for (let k = 0; k < setLefts.length; k++) {
  goToProgress(times[k + 1]);
  const onScreenLeft = setLefts[k] + railX();
  check(`A2 组${k} 停靠居中`, near(onScreenLeft, (vw - CARD_W) / 2), `left=${onScreenLeft.toFixed(1)} 期望 ${(vw - CARD_W) / 2}`);
}

// A3 组1 停留期 3/4：扇形完全展开且可见
{
  const k = 1;
  const stay = (1 - TRANS) * (times[k + 2] - times[k + 1]);
  goToProgress(times[k + 1] + 0.75 * stay);
  const cards = cardSets[k].querySelectorAll('.stack-card');
  const gaps = cards.map((_, i) => i * 10);
  cards.forEach((c, i) => {
    check(`A3 组1 卡${i} 展开 x=${gaps[i]}%`, near(cardX(c), gaps[i], 1.5) && cardOpacity(c) === '1', `x=${cardX(c)} opacity=${cardOpacity(c)}`);
  });
  const onScreenLeft = setLefts[k] + railX();
  check('A3b 组1 停留期仍居中', near(onScreenLeft, (vw - CARD_W) / 2), `left=${onScreenLeft.toFixed(1)}`);
}

// A4 end：完卡牌面居中（独立整体）
goToProgress(1);
check('A4 完卡牌面居中', near(faceLeft + railX(), (vw - FACE_W) / 2), `left=${(faceLeft + railX()).toFixed(1)} 期望 ${(vw - FACE_W) / 2}`);

// A5 提示淡出：首组到站时 opacity≈0
goToProgress(times[1]);
check('A5 首组到站提示已淡出', parseFloat(hint.style.opacity) <= 0.05, `opacity=${hint.style.opacity}`);

// A6 组2 到站前整组隐藏
{
  const k = 2;
  const cover = cardSets[k].querySelectorAll('.stack-card').at(-1);
  goToProgress(times[k + 1] - 0.35 * (times[k + 1] - times[k]));
  check('A6 组2 到站前封面隐藏', cardOpacity(cover) === '0', `opacity=${cardOpacity(cover)}`);
}

console.log(fails.length ? `\n${fails.length} 项断言失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
