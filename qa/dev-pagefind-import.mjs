#!/usr/bin/env node
/* 回归锁：博客页 Pagefind 搜索 UI（2026-09-12 方案二版）
 *
 * 历史：v1 锁的是方案一（手写 UI + 运行时 import /pagefind/pagefind.js）
 * 的 dev 解析坑——字面量 specifier 被 vite:import-analysis 无条件静态
 * resolve 抛 "Failed to resolve import"。方案二（用户裁定：
 * @pagefind/default-ui 构建时打包）落地后该风险结构性消除（包名
 * specifier 是 Vite 原生支持路径），v1 失去保护对象，就地改写。
 *
 * 现在锁四件事（纯本地文件断言，无网络无 dev server，秒级）：
 *   1. 源码形态：搜索脚本必须是「import.meta.env.DEV 门控 +
 *      import('@pagefind/default-ui')」，且不残留方案一的运行时
 *      import 索引产物写法（import(...) 内出现 pagefind.js）；
 *   2. 自定义清除按钮：源码必须含 .search-clear 圆圈 × 结构，且隐藏
 *      default-ui 自带文本清除按钮（.pagefind-ui__search-clear）；
 *   3. 产物折叠（若 dist/blog/index.html 存在）：dev 兜底文案已被
 *      构建期折叠剔除、生产错误分支与挂载点保留；
 *   4. 产物 chunk：dist/_astro/ 存在 default-ui chunk（含 PagefindUI
 *      标识、>50KB）。
 * 产物比源码旧时 exit 2（提示先 build），不算真回归。
 * 退出码：0 通过 / 1 真回归 / 2 环境问题。
 * 不含 Chrome / 截图（遵守「改后不跑无头浏览器」约定）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = ROOT + 'src/pages/blog/[...page].astro';
const DIST_HTML = ROOT + 'dist/blog/index.html';
const DIST_ASTRO = ROOT + 'dist/_astro/';

const problems = [];

/* ── 1. 源码形态 ── */
const src = readFileSync(SRC, 'utf8');
if (!src.includes('import.meta.env.DEV')) {
	problems.push('源码缺少 import.meta.env.DEV 门控（dev 会挂载无索引的 UI）');
}
if (!/import\(['"`]@pagefind\/default-ui['"`]\)/.test(src)) {
	problems.push(
		"源码找不到 import('@pagefind/default-ui')——可能退回了方案一（运行时 import 索引产物）路线",
	);
}
if (/import\([^)]*pagefind\.js/.test(src)) {
	problems.push('源码残留方案一的运行时 import 产物写法（import(...) 内含 pagefind.js）');
}
if (!src.includes('search-clear')) {
	problems.push('源码缺少自定义圆圈 × 清除按钮（search-clear）');
}
if (!src.includes('.pagefind-ui__search-clear')) {
	problems.push('源码未隐藏 default-ui 自带文本清除按钮（.pagefind-ui__search-clear）');
}

/* ── 2+3+4. 产物断言 ── */
if (!existsSync(DIST_HTML)) {
	console.error('[pagefind-ui] dist 未构建，产物断言跳过。请先 npm run build 再重跑本脚本。');
	process.exit(2);
}

const srcMtime = statSync(SRC).mtimeMs;
const distMtime = statSync(DIST_HTML).mtimeMs;
if (srcMtime > distMtime) {
	console.error('[pagefind-ui] 源码比 dist 新，产物可能过期。请先 npm run build 再重跑本脚本。');
	process.exit(2);
}

const html = readFileSync(DIST_HTML, 'utf8');
if (!html.includes('search-mount')) {
	problems.push('生产产物找不到搜索挂载点 #search-mount');
}

/* 含动态 import 的脚本不再内联：dev 兜底文案 / 错误分支在 HTML 或
 * dist/_astro/*.js（入口 chunk）中都可能出现，扫描全部产物文本；
 * frontmatter import 的 ui.css 打成 dist/_astro/*.css，一并扫描 */
const productTexts = [html];
if (existsSync(DIST_ASTRO)) {
	for (const f of readdirSync(DIST_ASTRO)) {
		if (f.endsWith('.js') || f.endsWith('.css')) {
			try {
				productTexts.push(readFileSync(DIST_ASTRO + f, 'utf8'));
			} catch {}
		}
	}
}
const allText = productTexts.join('\n');

if (allText.includes('dev 模式无索引')) {
	problems.push('生产产物含 dev 兜底文案——DEV 门控未被构建期折叠');
}
if (!allText.includes('检索 UI 加载失败')) {
	problems.push('生产产物缺生产错误分支（错误外显被删或未打包）');
}
if (!allText.includes('.pagefind-ui')) {
	problems.push("产物缺 default-ui 样式（ui.css 未引入，输入框会裸原生样式）——检查 import '@pagefind/default-ui/css/ui.css'");
}

/* default-ui chunk：minify 会混淆 PagefindUI 标识符，用其 DOM/CSS
 * 类名前缀 'pagefind-ui'（字符串字面量，minify 保留）作强标识 */
let uiChunkOk = false;
if (existsSync(DIST_ASTRO)) {
	for (const f of readdirSync(DIST_ASTRO)) {
		if (!f.endsWith('.js')) continue;
		const p = DIST_ASTRO + f;
		if (statSync(p).size > 50_000) {
			try {
				if (readFileSync(p, 'utf8').includes('pagefind-ui')) {
					uiChunkOk = true;
					console.log(`[pagefind-ui] default-ui chunk：_astro/${f}（${(statSync(p).size / 1024).toFixed(1)}KB min）`);
					break;
				}
			} catch {}
		}
	}
} else {
	console.error('[pagefind-ui] dist/_astro/ 不存在，chunk 断言无法执行。');
}
if (!uiChunkOk) {
	problems.push('dist/_astro/ 找不到 default-ui chunk（>50KB 且含 pagefind-ui 类名）——构建时打包可能未生效');
}

if (problems.length) {
	console.error('[pagefind-ui] 回归未通过：');
	for (const p of problems) console.error('  - ' + p);
	process.exit(1);
}
console.log('[pagefind-ui] 通过：源码形态正确，产物折叠/挂载点/UI chunk 均符合方案二契约');
