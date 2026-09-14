// /works/ 轨道停靠契约回归（纯 Node，无浏览器）。
//
// 背景：2026-09-14 22:2x 定稿模型（回归 HEAD 0c7eb21 步进节奏 + 用户文字
// 规格，见 works-view.js 文件头「每段三拍节奏」）：
//   stops = [set0..setN, end]（无 intro 停靠，首屏 = 组 0 居中 + 卡 0 立即可见）；
//   每段 = 飞入期(FLY) + 空转停顿(IDLE) + 过渡；组 k>0 到站前整组 opacity 0
//   （空白滑入），到站后卡 1..n 依次飞入（HEAD 编排，绑行程权重时间轴）。
// 本脚本把以下契约锁成回归：
//
//   - 不起浏览器：用 DOM 桩镜像 works-rail.css 的布局公式与 works-view.js
//     的编排常量，导入真实的 src/lib/works-view.js（其内部 import 真实的
//     works-rail.js），用虚拟 requestAnimationFrame 驱动滚轮输入到收敛。
//   - 断言契约：
//       A1  首屏：组 0 居中、卡 0 立即可见（x=0）、卡 1/2 隐藏、提示可见；
//       A2  各组停靠居中（progress=times[k]）；
//       A3  组 1 飞入期中间态：卡 0 已就位、卡 1 飞行途中、卡 2 未出现；
//       A3e 组 1 飞入期结束：满扇（x=0/10/20%）且组居中；
//       A3f 组 1 空转停顿期：轨道钉住、扇形保持；
//       A4  end 停靠：「完」牌面居中（独立整体，单独到站）；
//       A5  首屏提示：首屏 opacity=1，组 1 到站时淡出完毕；
//       A6  过渡期：下一组空白滑入（opacity 0），当前组满扇被推走；
//       A7  倒放可逆：倒滚到组 2 飞入中点呈中间态，倒滚到到站点呈空白；
//       A8  快滚直达终点：跳过全部中间拍，末组仍满扇。
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
const GAP = clampN(0.14 * vw, 48, 180);        // .set-gap width（14vw，与 CSS 同步）
const END_PAD = clampN(0.06 * vw, 40, 80);     // .end-set padding-left
const FACE_W = clampN(0.20 * vw, 180, 230);    // .endcard-face width

// ── 编排常量：必须与 works-view.js 逐字同步 ──────────────────────────────
const FLY = 0.5;
const IDLE = 0.08;
const STAG = 0.25;
const FLY_WIN = 0.35;

// 真实数据（profile.json works）：site/engine/app/craft，卡数 = 作品数 + 封面
const CARD_COUNTS = [3, 3, 2, 3];

const setLefts = [];
{ let x = PAD; for (let i = 0; i < CARD_COUNTS.length; i++) { setLefts.push(x); x += CARD_W + GAP; } }
const endSetLeft = setLefts[setLefts.length - 1] + CARD_W; // 末组后无 set-gap
const faceLeft = endSetLeft + END_PAD;

// 镜像 works-view.js geometry() 的停靠点公式（无 intro 停靠）
const setCenters = setLefts.map((l) => l - (vw - CARD_W) / 2);
const endCenter = faceLeft - (vw - FACE_W) / 2;
const centers = [...setCenters, endCenter];
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
const cardsOf = (k) => cardSets[k].querySelectorAll('.stack-card');

const fails = [];
function check(name, ok, detail) {
  if (!ok) fails.push(`${name}  ←  ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// A1 首屏：组 0 居中 + 卡 0 立即可见 + 卡 1/2 隐藏 + 提示可见
{
  const onScreenLeft = setLefts[0] + railX();
  check('A1 首屏组 0 居中', near(onScreenLeft, (vw - CARD_W) / 2), `left=${onScreenLeft.toFixed(1)} 期望 ${(vw - CARD_W) / 2}`);
  const [c0, c1, c2] = cardsOf(0);
  check('A1b 首屏卡 0 立即可见', cardOpacity(c0) === '1' && near(cardX(c0), 0, 0.5), `opacity=${cardOpacity(c0)} x=${cardX(c0)}`);
  check('A1c 首屏卡 1/2 隐藏', cardOpacity(c1) === '0' && cardOpacity(c2) === '0', `op1=${cardOpacity(c1)} op2=${cardOpacity(c2)}`);
  check('A1d 首屏提示可见', hint.style.opacity === '1', `opacity=${hint.style.opacity}`);
}

// A2 各组停靠居中（组 k 到站 = times[k]）
for (let k = 0; k < setLefts.length; k++) {
  goToProgress(times[k]);
  const onScreenLeft = setLefts[k] + railX();
  check(`A2 组${k} 停靠居中`, near(onScreenLeft, (vw - CARD_W) / 2), `left=${onScreenLeft.toFixed(1)} 期望 ${(vw - CARD_W) / 2}`);
}

// A3 组 1 飞入期中间态（sp=0.24 → flyP=0.48）：卡 0 就位、卡 1 途中、卡 2 未出现
// ⚠️ 进度点避开 flyP=0.5（卡 2 起飞点）：reveal>0 的可见性判断在浮点边界上会抖动
{
  const seg1 = times[2] - times[1];
  goToProgress(times[1] + 0.24 * seg1);
  const [c0, c1, c2] = cardsOf(1);
  check('A3 组1 飞入中卡 0 就位', near(cardX(c0), 0, 0.5) && cardOpacity(c0) === '1', `x=${cardX(c0)} op=${cardOpacity(c0)}`);
  const x1 = cardX(c1);
  check('A3b 组1 飞入中卡 1 途中', x1 > 10 && x1 < 80 && cardOpacity(c1) === '1', `x=${x1} op=${cardOpacity(c1)}`);
  check('A3c 组1 飞入中卡 2 未出现', cardOpacity(c2) === '0', `op=${cardOpacity(c2)}`);
  const onScreenLeft = setLefts[1] + railX();
  check('A3d 组1 飞入期钉在中心', near(onScreenLeft, (vw - CARD_W) / 2), `left=${onScreenLeft.toFixed(1)}`);
}

// A3e 组 1 飞入期结束（sp=FLY）：满扇
{
  const seg1 = times[2] - times[1];
  goToProgress(times[1] + FLY * seg1);
  const cards = cardsOf(1);
  cards.forEach((c, i) => {
    check(`A3e 组1 飞入完成卡${i} 满扇 x=${i * 10}%`, near(cardX(c), i * 10, 1.5) && cardOpacity(c) === '1', `x=${cardX(c)} op=${cardOpacity(c)}`);
  });
}

// A3f 组 1 空转停顿期（sp=FLY+IDLE/2）：轨道钉住、扇形保持
{
  const seg1 = times[2] - times[1];
  goToProgress(times[1] + (FLY + IDLE / 2) * seg1);
  const cover = cardsOf(1).at(-1);
  const onScreenLeft = setLefts[1] + railX();
  check('A3f 组1 空转期钉在中心', near(onScreenLeft, (vw - CARD_W) / 2), `left=${onScreenLeft.toFixed(1)}`);
  check('A3g 组1 空转期扇形保持', near(cardX(cover), 20, 1.5) && cardOpacity(cover) === '1', `x=${cardX(cover)} op=${cardOpacity(cover)}`);
}

// A4 end：完卡牌面居中（独立整体）
goToProgress(1);
check('A4 完卡牌面居中', near(faceLeft + railX(), (vw - FACE_W) / 2), `left=${(faceLeft + railX()).toFixed(1)} 期望 ${(vw - FACE_W) / 2}`);

// A5 提示淡出：组 1 到站时 opacity≈0
goToProgress(times[1]);
check('A5 组1 到站提示已淡出', parseFloat(hint.style.opacity) <= 0.05, `opacity=${hint.style.opacity}`);

// A6 过渡期：下一组空白滑入（opacity 0），当前组满扇被推走
{
  const seg1 = times[2] - times[1];
  goToProgress(times[1] + (FLY + IDLE + 0.5 * (1 - FLY - IDLE)) * seg1); // 过渡中点
  check('A6a 过渡中组 2 空白', cardsOf(2).every((c) => cardOpacity(c) === '0'), `ops=${cardsOf(2).map(cardOpacity).join(',')}`);
  const expected = [0, 10, 20];
  check('A6b 过渡中组 1 满扇', cardsOf(1).every((c, i) => cardOpacity(c) === '1' && near(cardX(c), expected[i], 1.5)), `ops=${cardsOf(1).map(cardOpacity).join(',')}`);
}

// A7 倒放可逆：倒滚到组 2 飞入中点呈中间态，倒滚到到站点呈空白（HEAD 语义）
// 组 2 只有 2 张卡（CARD_COUNTS[2]=2），断言卡 0/卡 1
{
  const seg2 = times[3] - times[2];
  goToProgress(times[2] + 0.24 * seg2); // 组 2 飞入期中段
  const [c0, c1] = cardsOf(2);
  check('A7a 倒滚组 2 飞入中态', near(cardX(c0), 0, 0.5) && cardOpacity(c0) === '1' && cardOpacity(c1) === '1' && cardX(c1) > 10 && cardX(c1) < 80, `x0=${cardX(c0)} op0=${cardOpacity(c0)} x1=${cardX(c1)} op1=${cardOpacity(c1)}`);
  goToProgress(times[2]); // 组 2 到站：整组空白（尚未飞入）
  check('A7b 倒滚组 2 到站空白', cardsOf(2).every((c) => cardOpacity(c) === '0'), `ops=${cardsOf(2).map(cardOpacity).join(',')}`);
  goToProgress(times[1]); // 组 1 到站：同样空白
  check('A7c 倒滚组 1 到站空白', cardsOf(1).every((c) => cardOpacity(c) === '0'), `ops=${cardsOf(1).map(cardOpacity).join(',')}`);
}

// A8 快滚直达终点：跳过全部中间拍，末组仍满扇
{
  goToProgress(1);
  const cards = cardsOf(3);
  cards.forEach((c, i) => {
    check(`A8 直达终点组 3 卡${i} 满扇 x=${i * 10}%`, near(cardX(c), i * 10, 1.5) && cardOpacity(c) === '1', `x=${cardX(c)} op=${cardOpacity(c)}`);
  });
}

console.log(fails.length ? `\n${fails.length} 项断言失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
