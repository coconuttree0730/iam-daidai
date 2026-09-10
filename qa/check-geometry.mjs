/* 版式几何硬指标检查（不含审美判断）
 *
 * 判定项：
 *   A 卡片四角是否都在视口内（留 6px 安全边）
 *   B 卡片多边形是否与「个人档案馆」「About Me」「信息条」的矩形相交
 *     （卡片是旋转过的矩形，用 AABB 会误报，所以做多边形×矩形求交）
 *   C 人物头部区间是否与卡片多边形重叠（只报告重叠比例，不判失败）
 *
 * 用法： CDP_PORT=9347 node qa/check-geometry.mjs <URL> <W> <H>
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2];
const W = Number(process.argv[3]);
const H = Number(process.argv[4]);
const PORT = process.env.CDP_PORT ?? '9347';
mkdirSync('qa/out', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
const connect = (ws) => (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', h);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const t = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const send = connect(ws);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
await send('Page.navigate', { url: URL_ });
await sleep(3000);

const out = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
  /* 把元素按 transform 展开成页面坐标下的四角 */
  const corners = (el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    /* 注意：必须用 offsetWidth/Height（未经 transform 的本体尺寸）。
       getBoundingClientRect 给的是 transform 之后的 AABB，
       拿它的一半再套一次矩阵会把卡片算大一圈。 */
    const hw = el.offsetWidth / 2, hh = el.offsetHeight / 2;
    return [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([x,y]) => ({
      x: cx + m.a * x + m.c * y, y: cy + m.b * x + m.d * y }));
  };
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
             cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
  const inside = (pts, x, y) => {              // 凸多边形内点测试（同向叉积）
    let neg = 0, pos = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cr < -1e-6) neg++; else if (cr > 1e-6) pos++;
    }
    return neg === 0 || pos === 0;
  };
  const hitArea = (poly, r) => {               // 采样：比例近似相交面积
    let hit = 0, total = 0;
    for (let i = 1; i <= 24; i++) for (let j = 1; j <= 24; j++) {
      const x = r.l + (r.w * i) / 25, y = r.t + (r.h * j) / 25;
      total++; if (inside(poly, x, y)) hit++;
    }
    return hit / total;
  };

  const stageEl = document.querySelector('.stage');
  /* 自定义属性经 getComputedStyle 取回的是未化简的 token 串
     （--figure-pad 会原样返回 "calc(min(62vh, 440px) * .0272)"），
     必须挂一个探针元素让浏览器真正解析成 px，否则 parseFloat 得到 NaN。 */
  const resolvePx = (varName) => {
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;width:var(' + varName + ')';
    stageEl.appendChild(p);
    const w = p.getBoundingClientRect().width;
    p.remove();
    return +w.toFixed(2);
  };

  const fig = document.querySelector('.hero-figure').getBoundingClientRect();
  /* 描边大字（.ghost）的实盒。它是最底层装饰、没有 FAIL 判据，但
     "把镂空字母移动 N px" 这类需求只能靠这个数验证——不记下来就只能目测。
     rect 是 scaleY(--ghost-stretch) 之后的盒子：transform-origin 是 top center，
     所以 rect.top 恒等于 CSS 的 top（缩放不动顶边）。 */
  const ghostEl = document.querySelector('.ghost');
  const gr = ghostEl.getBoundingClientRect();
  const cards = [...document.querySelectorAll('.card')].map((el, i) => {
    const p = corners(el);
    const r = el.getBoundingClientRect();
    const xs = p.map(q => q.x), ys = p.map(q => q.y);
    return {
      i: i + 1, no: el.querySelector('.card-no').textContent.trim(),
      title: el.querySelector('.card-title').textContent.trim(),
      theta: getComputedStyle(el).getPropertyValue('--theta').trim(),
      px: getComputedStyle(el).getPropertyValue('--px').trim() || '0px',
      py: getComputedStyle(el).getPropertyValue('--py').trim() || '0px',
      poly: p.map(q => ({ x: +q.x.toFixed(1), y: +q.y.toFixed(1) })),
      bbox: { x: +Math.min(...xs).toFixed(1), y: +Math.min(...ys).toFixed(1),
              r: +Math.max(...xs).toFixed(1), b: +Math.max(...ys).toFixed(1) },
      w: el.offsetWidth, h: el.offsetHeight,
      transform: getComputedStyle(el).transform,
      origin: getComputedStyle(el).transformOrigin,
      slotDx: getComputedStyle(el).getPropertyValue('--slot-dx').trim(),
      /* 标题的 transform 后 AABB。人物置顶后头部会盖住卡面，
         这条指标用来判断"盖掉的是不是字"。 */
      titleRect: (() => { const tr = el.querySelector('.card-title').getBoundingClientRect();
        return { l: +tr.left.toFixed(1), t: +tr.top.toFixed(1), r: +tr.right.toFixed(1),
                 b: +tr.bottom.toFixed(1), w: +tr.width.toFixed(1), h: +tr.height.toFixed(1) }; })(),
    };
  });
  const zones = {
    '个人档案': rectOf(document.querySelector('.title-zh')),
    'AboutMe': rectOf(document.querySelector('.mark-br')),
    '信息条': rectOf(document.querySelector('.infobar')),
    /* 必须取两个"词"而不是 .title-en 容器：容器是 space-between 的整行
       （3.4%–93.2% 宽），拿它做判定等于整行都是禁区，早期因此把这项
       从 collides 里排除掉，结果卡 01 压「PERSONAL」、卡 04 压「ARCHIVE」
       一直漏检——2026-09-10 实测两张卡的连通域与标题字母直接粘连。 */
    'PERSONAL': rectOf(document.querySelector('.title-en .w-left')),
    'ARCHIVE': rectOf(document.querySelector('.title-en .w-right')),
  };
  return {
    vp: { w: innerWidth, h: innerHeight },
    resolved: { figurePad: resolvePx('--figure-pad'), cardW: resolvePx('--card-w'),
                figureH: resolvePx('--figure-h'), cardTop: resolvePx('--card-top'),
                solidSize: resolvePx('--solid-size') },
    /* 窄屏层序契约要用：红色 PERSONAL 与中文标题在人物之上、
       黑色 ARCHIVE 在人物之下。取 z-index 原文（可能是 'auto'）。 */
    zorder: (() => {
      const z = (sel) => { const el = document.querySelector(sel);
        return el ? getComputedStyle(el).zIndex : null; };
      return { title: z('.title'), titleEn: z('.title-en'), wLeft: z('.title-en .w-left'),
               wRight: z('.title-en .w-right'), titleZh: z('.title-zh'),
               person: z('.hero-person'), fan: z('.fan') };
    })(),
    figure: { x: +fig.x.toFixed(1), y: +fig.y.toFixed(1), w: +fig.width.toFixed(1), h: +fig.height.toFixed(1) },
    ghost: { x: +gr.x.toFixed(1), y: +gr.y.toFixed(1), r: +gr.right.toFixed(1), b: +gr.bottom.toFixed(1),
             w: +gr.width.toFixed(1), h: +gr.height.toFixed(1),
             cssTop: getComputedStyle(ghostEl).top },
    /* 舞台与 .title 的实测盒。**定位基准不是视口高**：
       .title 是 h1，inset:0 之下仍带 UA 默认 margin（0.67em × 2em = 21.44px），
       所以它的 height = 舞台高 − 42.9，且整体下移 21.44。
       --zh-bottom / --solid-baseline 的百分比都以这个 height 为基准，
       "把标题移动 N px" 的需求不算这一层就会差 5–17px（本次实测差 16.7px，
       排查花了一轮）。另外 .title-zh / .w-left 的实盒是**行盒**不是墨迹盒，
       Archivo Black 的大写在行盒内缩 ~0.09em、CJK 在行盒内缩 ~0.07em，
       所以"可视间隔"与"盒间隔"差 ~0.16em——判定视觉间距要按墨迹算。 */
    stage: { t: +stageEl.getBoundingClientRect().top.toFixed(1),
             h: +stageEl.getBoundingClientRect().height.toFixed(1) },
    titleBox: (() => { const r = document.querySelector('.title').getBoundingClientRect();
      return { t: +r.top.toFixed(1), h: +r.height.toFixed(1) }; })(),
    titles: {
      zh: rectOf(document.querySelector('.title-zh')),
      personal: rectOf(document.querySelector('.title-en .w-left')),
      archive: rectOf(document.querySelector('.title-en .w-right')),
    },
    cards, zones,
    vars: (() => { const cs = getComputedStyle(document.querySelector('.stage')); const o = {};
      for (const v of ['--design-h','--fan-r','--card-h','--card-w','--slot','--figure-h',
                       '--figure-pad','--zh-bottom','--solid-size'])
        o[v] = cs.getPropertyValue(v).trim(); return o; })(),
  };
})()`,
});
const d = out.result.value;

/* 面部区域：系数来自图集单格 482×602 的**实测轮廓**（逐行统计 alpha>32 的宽度）：
     墨迹顶 y=16   头最宽 y≈88–96   下巴/颈最窄 y=200   肩线 y≈270
   归一化（÷602）：头顶 0.0266、下巴 0.3322；头宽 178/482 = 0.369，居中
   → 水平 0.315–0.685。
   2026-09-10 之前这里写的是 0.02–0.24，只盖到额头、漏了下颌，
   于是"红词压在下巴上（实测红词 552–576 / 下巴 569）"被判成 0% 遮挡漏掉了。
   现在这个盒子同时覆盖五官与下颌，可用来判「红词是否挡脸」。 */
const face = {
  l: d.figure.x + d.figure.w * 0.315,
  t: d.figure.y + d.figure.h * 0.0266,
  w: d.figure.w * 0.369,
  h: d.figure.h * 0.3056,
};
face.r = face.l + face.w;
face.b = face.t + face.h;

/* node 侧重复一份几何判定，避免把结果在页面上下文里再算一遍 */
const insidePoly = (pts, x, y) => {
  let neg = 0, pos = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cr < -1e-6) neg++; else if (cr > 1e-6) pos++;
  }
  return neg === 0 || pos === 0;
};
const hitArea = (poly, r) => {
  let hit = 0, total = 0;
  for (let i = 1; i <= 24; i++) for (let j = 1; j <= 24; j++) {
    total++;
    if (insidePoly(poly, r.l + (r.w * i) / 25, r.t + (r.h * j) / 25)) hit++;
  }
  return hit / total;
};

/* 分离轴（SAT）：两个凸多边形是否真的相交。
   采样法（hitArea）会漏掉窄条交叠，判定"压字"必须用精确解。 */
const satHit = (A, B) => {
  const poly = (pts) => {
    const axes = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const nx = -(b.y - a.y), ny = b.x - a.x;
      const L = Math.hypot(nx, ny) || 1;
      axes.push({ x: nx / L, y: ny / L });
    }
    return axes;
  };
  const axes = [...poly(A), ...poly(B)];
  for (const n of axes) {
    const pa = A.map((p) => p.x * n.x + p.y * n.y);
    const pb = B.map((p) => p.x * n.x + p.y * n.y);
    if (Math.max(...pa) < Math.min(...pb) - 1e-6) return false;
    if (Math.max(...pb) < Math.min(...pa) - 1e-6) return false;
  }
  return true;
};
const rectPoly = (r) => [{ x: r.l, y: r.t }, { x: r.r, y: r.t }, { x: r.r, y: r.b }, { x: r.l, y: r.b }];
const polyRectHit = (poly, r) => satHit(poly, rectPoly(r));
/* 交叠面积比例（多边形裁剪太啰嗦，这里用采样，只用于报告数量级） */
const overlapRatio = (poly, r) => {
  // 用卡片自身的多边形做积分域太慢，改成在被交叠的 AABB 内采样
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const box = { l: Math.max(Math.min(...xs), r.l), t: Math.max(Math.min(...ys), r.t),
                r: Math.min(Math.max(...xs), r.r), b: Math.min(Math.max(...ys), r.b) };
  if (box.r <= box.l || box.b <= box.t) return 0;
  const w = box.r - box.l, h = box.b - box.t;
  let hit = 0, total = 0;
  for (let i = 1; i <= 24; i++) for (let j = 1; j <= 24; j++) {
    total++;
    if (insidePoly(poly, box.l + (w * i) / 25, box.t + (h * j) / 25)) hit++;
  }
  const inter = (hit / total) * w * h;
  return inter / (r.w * r.h);
};

const probes = {};
const hardHit = {};          // 精确相交（SAT）的禁区名，参与 fail
for (const c of d.cards) {
  const over = {}, hard = [];
  for (const [name, r] of Object.entries(d.zones)) {
    if (!r) continue;
    over[name] = +hitArea(c.poly, r).toFixed(4);
    if (polyRectHit(c.poly, r)) hard.push(name);
  }
  probes[c.no] = over;
  hardHit[c.no] = hard;
}
const outside = d.cards.filter((c) =>
  c.bbox.x < 6 || c.bbox.y < 6 || c.bbox.r > W - 6 || c.bbox.b > H - 6 - d.zones['信息条'].h);
/* 压字：任一卡片多边形与禁区矩形真相交即 fail。
   2026-09-10 前这里排除了 'PERSONAL'，导致卡 01/04 压英文标题长期漏检。 */
const collides = d.cards.filter((c) => hardHit[c.no].length);

/* 卡片之间不得互相压叠。抬轴心后内外两圈会互相靠近，这条是护栏：
   用多边形精确相交，AABB 相交不算（卡片是斜的，AABB 天然重叠）。 */
const cardCard = [];
for (let i = 0; i < d.cards.length; i++) {
  for (let j = i + 1; j < d.cards.length; j++) {
    if (satHit(d.cards[i].poly, d.cards[j].poly)) cardCard.push(`${d.cards[i].no}×${d.cards[j].no}`);
  }
}

/* 面部被卡片覆盖的比例：任一张卡盖住即算遮挡，不做并集去重，
   因为多张卡重叠覆盖同一块脸在观感上并不比一张更糟。 */
const faceCover = Math.min(1, d.cards.reduce((s, c) => s + hitArea(c.poly, face), 0));

/* 标题 AABB 与面部盒的交叠比例（AABB 互交，够用且偏保守） */
const titleCover = {};
for (const c of d.cards) {
  const t = c.titleRect, a = { l: face.l, t: face.t, r: face.r, b: face.b };
  const ow = Math.max(0, Math.min(t.r, a.r) - Math.max(t.l, a.l));
  const oh = Math.max(0, Math.min(t.b, a.b) - Math.max(t.t, a.t));
  titleCover[c.no] = +((ow * oh) / (t.w * t.h)).toFixed(4);
}

/* 移动端硬指标：卡片行「最低点」到人物盒顶的间距。
   用旋转后多边形的最低点，而不是 bbox 中心或未旋转的底边——
   卡片绕底边中点转了 ±8°，外侧角会下垂 (w/2)·sin8° ≈ 5.9px，
   正是这个角决定视觉间距。
   人物盒顶 = 图集单格顶：选帧是去边裁切后的紧包围盒，头顶即盒顶。 */
const cardLow = Math.max(...d.cards.map((c) => c.bbox.b));
const headGap = +(d.figure.y - cardLow).toFixed(1);
/* 用户真正看到的是「墨迹顶 → 卡片下沿」。墨迹顶在单格顶**下方** padTop 处，
   所以可见间距 = 单格间距 + padTop（不是减——早期写反过一次，
   导致规格实际只有 16px 却被判成通过）。padTop 由 CSS 下发，不复制常数。 */
const padTop = d.resolved.figurePad;
const visibleGap = +(headGap + padTop).toFixed(1);

const rows = d.cards.map((c) =>
  `${c.no} ${c.title} θ=${c.theta.padEnd(8)} px=${c.px} py=${c.py} 宽高=${c.w}x${c.h} bbox=[${c.bbox.x},${c.bbox.y} → ${c.bbox.r},${c.bbox.b}] ` +
  Object.entries(probes[c.no]).map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`).join(' '));

console.log(`\n=== ${W}x${H} ===`);
console.log(`  变量 ${JSON.stringify(d.vars)}`);
console.log(`  人物包围盒 y ${d.figure.y}–${(d.figure.y + d.figure.h).toFixed(1)}  x ${d.figure.x}–${(d.figure.x + d.figure.w).toFixed(1)}`);
rows.forEach((r) => console.log('  ' + r));
console.log(`  出屏卡片: ${outside.length ? outside.map((c) => c.no).join(',') : '无'}`);
console.log(`  压字卡片: ${collides.length
  ? collides.map((c) => `${c.no}→${hardHit[c.no].join('+')}`).join('  ')
  : '无'}`);
console.log(`  卡片互压: ${cardCard.length ? cardCard.join(',') : '无'}`);
console.log(`  占位百分比: 01 ${Object.entries(probes['01'] || {}).filter(([,v]) => v > 0.005).map(([k,v]) => `${k}=${(v*100).toFixed(1)}%`).join(' ') || '—'}   04 ${Object.entries(probes['04'] || {}).filter(([,v]) => v > 0.005).map(([k,v]) => `${k}=${(v*100).toFixed(1)}%`).join(' ') || '—'}`);
console.log(`  描边大字 .ghost 顶 ${d.ghost.y}（CSS top ${d.ghost.cssTop}）底部 ${d.ghost.b}  高 ${d.ghost.h}`);
/* 标题三层的行盒 + 红词与中文标题的"盒间隔"。定位基准（.title 的 height，
   不是视口高）也一并打印——改 bottom 百分比时不看这个数会算错位移量。 */
const boxGap = +(d.titles.zh.t - d.titles.personal.b).toFixed(1);
/* 行盒内缩量 = Archivo Black 大写底 ~0.09em + CJK 顶 ~0.069em（本次实测反解）。
   用户说的"间隔 5px"是**可视间隔**（墨迹到墨迹），行盒间隔比它小这么多。 */
const inkGap = +(boxGap + 0.16 * d.resolved.solidSize).toFixed(1);
console.log(`  实心大字 红词 y ${d.titles.personal.t}–${d.titles.personal.b}（x ${d.titles.personal.l}–${d.titles.personal.r}）`
  + `  黑词 y ${d.titles.archive.t}–${d.titles.archive.b}  中文 y ${d.titles.zh.t}–${d.titles.zh.b}`);
console.log(`  红词↔中文 盒间隔 ${boxGap}px / 可视间隔 ≈ ${inkGap}px`
  + `   基准 舞台高 ${d.stage.h} / .title 顶 ${d.titleBox.t} 高 ${d.titleBox.h}`);
console.log(`  面部遮挡: ${(faceCover * 100).toFixed(1)}%   面部盒 x ${face.l.toFixed(0)}–${face.r.toFixed(0)}  y ${face.t.toFixed(0)}–${face.b.toFixed(0)}`);
console.log(`  标题被人物覆盖: ${d.cards.map((c) => `${c.no}=${(titleCover[c.no] * 100).toFixed(0)}%`).join('  ')}`);
console.log(`  头顶到卡片行: 单格顶 ${headGap}px / 可见 ${visibleGap}px   (留白 ${padTop.toFixed(1)} / 卡片最低 ${cardLow.toFixed(1)} / 单格顶 ${d.figure.y})`);
writeFileSync(`qa/out/geometry-${W}x${H}.json`,
  JSON.stringify({ faceCover, face, headGap, visibleGap, padTop, cardLow, probes, hardHit, cardCard, ...d }, null, 2));
ws.close();
/* 面部遮挡阈值只在窄屏生效：
   桌面版式里卡片本来就压在头两侧（鬓角/耳），面部盒这种矩形近似
   会把"造型刻意重叠"误判成遮挡，因此桌面仅作参考不参与判定。
   移动端 2026-09-10 起卡片已贴在 viewport 顶部、跟 head 脱钩，
   这条规则在窄屏不再有意义，归零即可。 */
const faceGate = false;
/* 移动端硬指标：卡片行「顶部最高点」必须落在锚点附近。
   判据不写死像素——卡片行的锚点是 hero.css 的 --card-top，2026-09-10 由
   22px 下移到 42px；写死上界的话每次调锚点都要改测试（改测试比改代码危险）。
   这里反过来从 CSS 取锚点，再验"实测最高点 = 锚点 − (w/2)·sin8°"：
     上界 anchor + 2  → 卡片不能被整体推低（规格悄悄失效）
     下界 anchor − 12 → 卡片不能被整体顶高（(w/2)·sin8° ≈ 5px，留 2 倍余量）
   因为 4 张卡绕顶边中点摆 ±8°，最高点是外侧卡**旋转后抬起的那个角**，
   不是锚点本身——所以下界必须容纳这段旋转外扩，不能写成 cardTop ≥ anchor。 */
const cardTop = Math.min(...d.cards.map((c) => c.bbox.y));
const anchor = Number.isFinite(d.resolved.cardTop) && d.resolved.cardTop > 0 ? d.resolved.cardTop : 62;
const topGate = W <= 640 && (cardTop < anchor - 12 || cardTop > anchor + 2);
if (W <= 640) console.log(`  卡片行顶部最高点 y ${cardTop.toFixed(1)} (锚点 ${anchor} → 规格 ${anchor - 12}–${anchor + 2})`);

/* 窄屏层序契约（用户 2026-09-10 指定）：
     红色 PERSONAL  → 人物之上（和「个人档案馆」同层）
     黑色 ARCHIVE   → 人物之下（保持不动）
   这里比较的是 z-index 数值，而数值比较只有在 .title / .title-en 都是
   `auto`、所有元素同处 .stage 这一个层叠上下文时才成立——**这三条一起断言**：
   一旦有人给 .title-en 加回 z-index，它会自建层叠上下文，`.w-left` 的 6
   就只在容器内部比大小、再也爬不出人物那一层，契约静默失效而肉眼很难归因。 */
const z = d.zorder;
const zGate = W <= 640 && (z.title !== 'auto' || z.titleEn !== 'auto'
  || !(+z.wLeft > +z.person) || !(+z.wRight < +z.person));
if (W <= 640) console.log(`  层序 .title=${z.title} .title-en=${z.titleEn} w-left=${z.wLeft} w-right=${z.wRight} 中文=${z.titleZh} 人物=${z.person} 卡片=${z.fan}`);

/* 窄屏红词↔中文标题的间距契约（用户 2026-09-10 指定"上下间隔 5px"）。
   门开得比规格宽（可视间隔 1–9px），因为：
     · 行盒与墨迹的内缩差按 --solid-size 缩放，无法在 DOM 里精确测量；
     · 320–640 宽之间 --solid-size 从 25 涨到 44，可视间隔本身就会漂 ±1.5px。
   真正的缺陷是两个：红词压到中文标题上（负间隔）、或飘走（>9px）。 */
const gapGate = W <= 640 && (inkGap < 1 || inkGap > 9);
if (W <= 640) console.log(`  红词↔中文 间隔门 可视 ${inkGap}px（规格 5，容差 1–9）`);

/* 窄屏「红词不得挡脸」契约（用户 2026-09-10：这是瑕疵，必须解决）。
   判据用**墨迹顶**对**下巴**：红词行盒内墨迹上缩 0.018·S（实测反解），
   下巴 = 人物盒顶 + 0.3322·figure-h（单格 y=200/602，见 face 的定义）。
   改前红词墨迹 552–576、下巴 569 → 差 −17px，压在下颌上，肉眼可辨。
   留 8px 容差吸收字体的墨迹内缩在不同字号下的取整。 */
const S = d.resolved.solidSize;
const chin = d.figure.y + d.figure.h * 0.3322;
const personalInkTop = +(d.titles.personal.t + 0.018 * S).toFixed(1);
const faceGate2 = W <= 640 && personalInkTop < chin - 8;
if (W <= 640) console.log(`  红词墨迹顶 ${personalInkTop} / 下巴 ${chin.toFixed(1)} → ${faceGate2 ? '✗ 挡脸' : 'ok 在胸部'}`);

process.exit(outside.length || collides.length || cardCard.length || faceGate || topGate || zGate || gapGate || faceGate2 ? 1 : 0);
