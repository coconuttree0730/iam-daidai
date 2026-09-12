#!/usr/bin/env node
/* 回归锁：博客页 Pagefind 动态 import 在 astro dev 下的解析（2026-09-12）
 *
 * 病史：dev 的 vite:import-analysis 对「字面量 specifier」的动态 import 会
 * 无条件静态 resolve 并抛 "Failed to resolve import"——@vite-ignore 在 dev
 * 该路径不生效（它只抑制非字面量 import 的 warning；build 侧 rollup 才真正
 * 尊重它）。因此 ensurePagefind 里的 specifier 必须保持非字面量（变量拼接）。
 *
 * 本脚本 = 一条 curl 的固化：取博客列表页脚本虚拟模块，断言 transform 通过
 * 且 specifier 未还原成完整字面量。
 *
 * 服务器选择：优先复用已在跑的 dev server（DEV_PAGEFIND_URL 或 127.0.0.1:4321，
 * 只读请求不影响会话）；都不可达才用 `astro dev --ignore-lock` 自起独立实例
 * （不碰既有 server 的锁文件），结束时尽力 SIGTERM。
 * 退出码：0 通过 / 1 真回归 / 2 环境问题（含「dev server 编译缓存陈旧，
 * 请重启 dev server」——本机实测过 watcher 对 .astro 编辑可能不失效编译缓存）。
 * 不含 Chrome / 截图（遵守「改后不跑无头浏览器」约定）。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_FILE = ROOT + 'src/pages/blog/[...page].astro';
const SPAWN_PORT = 4397;
const MODULE_PATH = '/src/pages/blog/%5B...page%5D.astro?astro&type=script&index=0&lang.ts';

const candidates = [];
if (process.env.DEV_PAGEFIND_URL) candidates.push(process.env.DEV_PAGEFIND_URL);
candidates.push('http://127.0.0.1:4321');

let base = null;
for (const c of candidates) {
	try {
		const r = await fetch(c + '/', { signal: AbortSignal.timeout(2500) });
		if (r.ok) { base = c.replace(/\/$/, ''); break; }
	} catch {}
}

let spawned = null;
if (!base) {
	console.log('[dev-pagefind] 无运行中的 dev server，自起独立实例（--ignore-lock）…');
	spawned = spawn('npx', ['astro', 'dev', '--port', String(SPAWN_PORT), '--host', '127.0.0.1', '--ignore-lock'], {
		cwd: ROOT, stdio: 'ignore', detached: true,
	});
	spawned.on('error', () => {});
	base = `http://127.0.0.1:${SPAWN_PORT}`;
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(base + '/', { signal: AbortSignal.timeout(2000) });
			if (r.ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
		if (i === 119) {
			console.error('[dev-pagefind] 自起 dev server 超时（60s）');
			exit(2);
		}
	}
}

const shutdownSpawned = () => {
	if (spawned?.pid) { try { process.kill(-spawned.pid, 'SIGTERM'); } catch {} }
};
function exit(code) {
	shutdownSpawned();
	process.exit(code);
}
process.on('SIGINT', () => exit(2));
process.on('SIGTERM', () => exit(2));

try {
	const res = await fetch(base + MODULE_PATH, { signal: AbortSignal.timeout(15000) });
	const body = await res.text();

	// 磁盘源码是否仍含「完整字面量 specifier」（= 修复被回退）
	const disk = readFileSync(SRC_FILE, 'utf8');
	const diskHasLiteral =
		disk.includes('"/pagefind/pagefind.js"') || disk.includes("'/pagefind/pagefind.js'");

	const problems = [];
	if (res.status !== 200) {
		problems.push(`虚拟模块 transform 失败：HTTP ${res.status}（应 200）`);
		if (diskHasLiteral) {
			console.error('[dev-pagefind] 真回归：源码仍是字面量 specifier，dev 必然解析失败。');
			exit(1);
		}
		console.error(
			'[dev-pagefind] 源码已是修复后写法，但 transform 失败 → dev server 编译缓存陈旧\n' +
			'  （本机已知：watcher 对 .astro 编辑可能不失效编译缓存）。请重启 dev server 后重测。');
		exit(2);
	}
	if (body.includes('"/pagefind/pagefind.js"') || body.includes("'/pagefind/pagefind.js'")) {
		problems.push('specifier 在产物中以完整字面量出现——dev 会静态 resolve；必须保持变量拼接');
	}
	if (!body.includes('pagefind.js')) {
		problems.push('模块里找不到 pagefind 引用（可能页面改版、测错了模块）');
	}

	if (problems.length) {
		console.error('[dev-pagefind] 回归未通过：');
		for (const p of problems) console.error('  - ' + p);
		exit(1);
	}
	console.log(`[dev-pagefind] 通过（dev server: ${base}）：transform 200，specifier 保持非字面量`);
	exit(0);
} catch (e) {
	console.error('[dev-pagefind] 环境不可用：' + (e?.message ?? e));
	exit(2);
}
