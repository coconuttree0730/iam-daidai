/* 图集运动结构分析：判断 46 帧是否构成「单调角度扫掠」还是「往复运动」
 *
 * 这是回答「帧随动为什么不自然」的诊断工具，不参与页面运行时。
 *
 * 用法：
 *   node qa/analyze-atlas-motion.mjs            # 需要先跑过 extract（见下）
 *   node qa/analyze-atlas-motion.mjs --extract  # 从 motion.webp 重新导出中间平面
 *
 * 判据：
 *   1) 相邻帧差异曲线 —— 若为单调扫掠，应大体平稳；若出现成组的对称极小值
 *      （f_i ≈ f_{i+k} 且 k 小），说明动作在往复。
 *   2) 头部水平质心轨迹 —— 单调扫掠应单调；往复运动会有峰谷反转。
 *   3) 首尾闭环 MAD(45,0) 与相邻均值之比 —— 判断接缝是否可接受。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'motion', 'head-turn', 'candidates', 'atlas48');
const WORK = join(ROOT, '.tmp', 'atlas-motion');
const ALPHA_RAW = join(WORK, 'alpha.raw');
const RGB_RAW = join(WORK, 'rgb.raw');

const W = 3856;
const H = 3612;
const CW = 482;
const CH = 602;
const COLS = 8;
const N = 46;
const AL = 16; // alpha 阈值

async function extract() {
  await mkdir(WORK, { recursive: true });
  const atlas = join(SRC, 'motion.webp');
  for (const [out, vf] of [
    [ALPHA_RAW, 'alphaextract,format=gray'],
    [RGB_RAW, 'format=rgb24'],
  ]) {
    const r = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', atlas, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', vf.includes('gray') ? 'gray' : 'rgb24', out],
      { stdio: 'inherit', env: { ...process.env, TMPDIR: join(ROOT, '.tmp') } }
    );
    if (r.status !== 0) throw new Error(`ffmpeg 导出失败：${out}`);
  }
}

/** 逐格采样（每 2px 一取），返回用于比对的紧凑表示 */
function decode(alphaBuf, rgbBuf) {
  const w = CW >> 1;
  const h = CH >> 1;
  const cells = [];
  for (let i = 0; i < N; i++) {
    const ox = (i % COLS) * CW;
    const oy = Math.floor(i / COLS) * CH;
    const rgb = new Uint8Array(w * h * 3);
    const a = new Uint8Array(w * h);
    for (let y = 0; y < CH; y += 2) {
      const row = (oy + y) * W;
      for (let x = 0; x < CW; x += 2) {
        const s = row + ox + x;
        const p = (y >> 1) * w + (x >> 1);
        rgb[p * 3] = rgbBuf[s * 3];
        rgb[p * 3 + 1] = rgbBuf[s * 3 + 1];
        rgb[p * 3 + 2] = rgbBuf[s * 3 + 2];
        a[p] = alphaBuf[s];
      }
    }
    cells.push({ rgb, a });
  }
  return cells;
}

/** 平均绝对差：只统计两帧任一有墨迹的像素 */
const mad = (cells, i, j) => {
  const p = cells[i];
  const q = cells[j];
  let s = 0;
  let c = 0;
  for (let k = 0; k < p.a.length; k++) {
    if (p.a[k] > AL || q.a[k] > AL) {
      s +=
        (Math.abs(p.rgb[k * 3] - q.rgb[k * 3]) +
          Math.abs(p.rgb[k * 3 + 1] - q.rgb[k * 3 + 1]) +
          Math.abs(p.rgb[k * 3 + 2] - q.rgb[k * 3 + 2])) /
        3;
      c++;
    }
  }
  return c ? s / c : 0;
};

/** 头部区域（顶部 220 行）的水平质心与宽度 */
function headMetrics(alphaBuf) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const ox = (i % COLS) * CW;
    const oy = Math.floor(i / COLS) * CH;
    let sx = 0;
    let sw = 0;
    let x0 = 1e9;
    let x1 = -1;
    for (let y = 0; y < 220; y++) {
      const row = (oy + y) * W;
      for (let x = 0; x < CW; x++) {
        if (alphaBuf[row + ox + x] > AL) {
          sx += x;
          sw++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
      }
    }
    out.push({ cx: sx / sw, w: x1 - x0 + 1, x0, x1 });
  }
  return out;
}

const main = async () => {
  if (process.argv.includes('--extract') || !existsSync(ALPHA_RAW) || !existsSync(RGB_RAW)) {
    await extract();
  }
  const cells = decode(await readFile(ALPHA_RAW), await readFile(RGB_RAW));
  const head = headMetrics(await readFile(ALPHA_RAW));

  const adj = [];
  for (let i = 0; i < N - 1; i++) adj.push(mad(cells, i, i + 1));
  const mean = adj.reduce((a, b) => a + b, 0) / adj.length;
  const max = Math.max(...adj);
  const min = Math.min(...adj);

  const lines = [];
  lines.push('=== 相邻帧差异 MAD(i,i+1) ===');
  for (let i = 0; i < adj.length; i++) {
    lines.push(
      `${String(i).padStart(2)}→${String(i + 1).padStart(2)} ${adj[i].toFixed(2).padStart(6)} ${'#'.repeat(Math.round((adj[i] / max) * 50))}`
    );
  }
  lines.push('');
  lines.push(`相邻 MAD：均值=${mean.toFixed(2)} 最大=${max.toFixed(2)} 最小=${min.toFixed(2)} 峰谷比=${(max / min).toFixed(1)}x`);

  const loop = mad(cells, 45, 0);
  lines.push(`★ 接缝 MAD(45,0)=${loop.toFixed(2)}  = 相邻均值的 ${(loop / mean).toFixed(2)}x  → ${loop <= mean * 1.2 ? '闭环成立（接缝不比普通相邻步更大）' : '闭环不成立（接缝处会跳）'}`);

  lines.push('');
  lines.push('=== 头部水平质心轨迹（顶部 220 行）===');
  for (let i = 0; i < N; i++) {
    lines.push(`f${String(i).padStart(2)}  cx=${head[i].cx.toFixed(1).padStart(6)}  宽=${String(head[i].w).padStart(3)}`);
  }
  const reversals = [];
  for (let i = 1; i < N - 1; i++) {
    const d0 = head[i].cx - head[i - 1].cx;
    const d1 = head[i + 1].cx - head[i].cx;
    if (d0 * d1 < 0 && Math.abs(d0) > 0.5 && Math.abs(d1) > 0.5) reversals.push(i);
  }
  lines.push(`★ 方向反转点：${reversals.length ? reversals.map((i) => 'f' + i).join(', ') : '无'} → ${reversals.length === 0 ? '单调扫掠' : '往复运动（非单调）'}`);

  lines.push('');
  lines.push('=== 每帧的最相似帧（排除自身与 ±2 邻域）===');
  const lagged = [];
  for (let i = 0; i < N; i++) {
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < N; j++) {
      if (Math.abs(i - j) <= 2) continue;
      const d = mad(cells, i, j);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    lagged.push({ i, best, bd, lag: Math.abs(i - best) });
    lines.push(`f${String(i).padStart(2)} 最像 f${String(best).padStart(2)} (MAD=${bd.toFixed(2)}, |Δ|=${Math.abs(i - best)})`);
  }
  const shortLags = lagged.filter((l) => l.lag <= 8 && l.best !== 45 && l.i !== 0).length;
  lines.push(`★ 短程对称匹配（|Δ|≤8）共 ${shortLags} 处 → ${shortLags >= 5 ? '强往复特征（动作来回摆）' : '无显著往复'}`);

  lines.push('');
  lines.push('=== 分象限可见变化量（契约帧段）===');
  const Q = [
    ['BL 左下', 0, 11],
    ['TL 左上', 12, 22],
    ['TR 右上', 23, 34],
    ['BR 右下', 35, 45],
  ];
  lines.push('象限      帧段    首末差异  区内相邻和  头部行程   平均每帧');
  const perFrame = {};
  for (const [n, s, e] of Q) {
    let sum = 0;
    for (let i = s; i < e; i++) sum += mad(cells, i, i + 1);
    const cxs = head.slice(s, e + 1).map((h) => h.cx);
    const span = Math.max(...cxs) - Math.min(...cxs);
    perFrame[n] = sum / (e - s);
    lines.push(
      `${n.padEnd(9)}${String(s).padStart(2)}-${String(e).padStart(2)}  ${mad(cells, s, e).toFixed(1).padStart(8)}${sum.toFixed(1).padStart(12)}${span.toFixed(1).padStart(10)}px${(sum / (e - s)).toFixed(2).padStart(12)}`
    );
  }
  const ratio = Math.max(...Object.values(perFrame)) / Math.min(...Object.values(perFrame));
  lines.push(`★ 象限间运动速度反差 = ${ratio.toFixed(1)}x  → ${ratio > 2 ? '严重不均（指针匀速扫过时，人物时快时慢甚至"假装静止"）' : '基本均匀'}`);

  const out = lines.join('\n');
  console.log(out);
  await writeFile(join(WORK, 'motion-structure.txt'), out);
  await writeFile(
    join(WORK, 'motion-structure.json'),
    JSON.stringify({ adj, mean, max, min, loop, head, reversals, lagged, perQuadrant: perFrame }, null, 2)
  );
  console.log(`\n报告写入 ${join(WORK, 'motion-structure.txt')}`);
};

await main();
