// spec 2026-09-12-blog-dark-og-code-mdx 的产物断言（单一接缝 = dist/）。
// 运行：node qa/spec-dark-og-mdx.test.mjs（必须在 npm run build 之后）
// 断言面全部落在构建产物文件上，不起 dev server、不跑无头浏览器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const blogDir = path.join(DIST, 'blog');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 1. 每篇详情页：og:image 绝对 URL 且指向真实存在的 PNG ──────────
const htmlFiles = walk(blogDir).filter((f) => f.endsWith('index.html'));
const detailPages = htmlFiles.filter((f) =>
  fs.readFileSync(f, 'utf8').includes('article:published_time'),
);
assert.ok(detailPages.length >= 3, `详情页数量异常：${detailPages.length}`);
for (const f of detailPages) {
  const html = fs.readFileSync(f, 'utf8');
  const m = html.match(
    /<meta property="og:image" content="(https:\/\/[^"]+\/og-image\/[^"]+\.png)"/,
  );
  assert.ok(m, `详情页缺 og:image 或非绝对 URL：${path.relative(DIST, f)}`);
  const pngPath = path.join(
    DIST,
    'og-image',
    path.basename(path.dirname(f)) + '.png',
  );
  assert.ok(
    fs.existsSync(pngPath),
    `og:image 指向的 PNG 不存在：${path.relative(DIST, pngPath)}`,
  );
}
console.log(`1. og:image 接线 OK（${detailPages.length} 篇详情页）`);

// ── 2. OG PNG 尺寸 = 1200×630 且非空 ────────────────────────────────
const pngs = walk(path.join(DIST, 'og-image')).filter((f) =>
  f.endsWith('.png'),
);
assert.ok(pngs.length >= 3, `og-image 产物数量异常：${pngs.length}`);
for (const f of pngs) {
  const buf = fs.readFileSync(f);
  assert.ok(buf.length > 10_000, `PNG 过小疑似失败：${f}`);
  // PNG IHDR：宽在 16..20，高在 20..24（大端 uint32）
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.equal(w, 1200, `PNG 宽度 ${w} ≠ 1200：${path.basename(f)}`);
  assert.equal(h, 630, `PNG 高度 ${h} ≠ 630：${path.basename(f)}`);
}
console.log(`2. OG PNG 尺寸 OK（${pngs.length} 张 1200×630）`);

// ── 3. expressive-code 产物含 data-theme 双主题选择器 ────────────────
const cssFiles = walk(path.join(DIST, '_astro')).filter((f) =>
  f.endsWith('.css'),
);
const allCss = cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
assert.ok(
  allCss.includes("[data-theme='dark']") || allCss.includes('[data-theme="dark"]'),
  'EC 产物 CSS 缺 [data-theme=dark] 选择器',
);
assert.ok(
  allCss.includes("[data-theme='light']") || allCss.includes('[data-theme="light"]'),
  'EC 产物 CSS 缺 [data-theme=light] 选择器',
);
console.log('3. expressive-code 双主题选择器 OK');

// ── 4. head 含主题初始化内联脚本（防 FOUC）───────────────────────────
const samplePages = [
  path.join(DIST, 'index.html'),
  path.join(DIST, 'blog', 'index.html'),
  ...detailPages.slice(0, 2),
];
for (const f of samplePages) {
  const html = fs.readFileSync(f, 'utf8');
  assert.ok(
    html.includes('documentElement.dataset.theme'),
    `页面 head 缺主题初始化脚本：${path.relative(DIST, f)}`,
  );
  assert.ok(
    html.includes('class="theme-toggle"'),
    `页面缺主题切换章：${path.relative(DIST, f)}`,
  );
}
console.log('4. 主题初始化脚本 + 切换章 OK');

// ── 5. MDX fixture 文章构建且内嵌组件已渲染 ──────────────────────────
const mdxPage = path.join(DIST, 'blog', 'hello-mdx', 'index.html');
assert.ok(fs.existsSync(mdxPage), 'MDX fixture 文章未产出：blog/hello-mdx/');
const mdxHtml = fs.readFileSync(mdxPage, 'utf8');
assert.ok(mdxHtml.includes('stamp-note'), 'MDX 内嵌组件标记未出现在正文中');
assert.ok(mdxHtml.includes('article:published_time'), 'MDX 详情页缺 article meta');
console.log('5. MDX fixture 渲染 OK');

console.log('\n全部产物断言通过 ✅');
