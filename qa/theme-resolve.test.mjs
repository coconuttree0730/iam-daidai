// 主题决策纯函数回归锁（2026-09-12 暗色模式）。
// 运行：node qa/theme-resolve.test.mjs
// 契约：resolveTheme 与 Base.astro head 内联脚本逻辑等价（两处同步）。
import assert from 'node:assert/strict';
import { resolveTheme, currentTheme, THEME_KEY } from '../src/lib/theme.js';

// 合法存储值优先
assert.equal(resolveTheme('dark', false), 'dark');
assert.equal(resolveTheme('light', true), 'light');
// 非法/缺失存储值 → 系统偏好兜底
assert.equal(resolveTheme(null, true), 'dark');
assert.equal(resolveTheme(undefined, false), 'light');
assert.equal(resolveTheme('', true), 'dark');
assert.equal(resolveTheme('blue', true), 'dark'); // 非法值视同缺失
// 系统偏好缺失（matchMedia 不可用传 false）→ 浅色
assert.equal(resolveTheme(null, false), 'light');

// currentTheme：未标记 → light 兜底
assert.equal(currentTheme({ dataset: {} }), 'light');
assert.equal(currentTheme({ dataset: { theme: 'dark' } }), 'dark');

assert.equal(THEME_KEY, 'theme');
console.log('qa/theme-resolve.test.mjs: all assertions passed');
