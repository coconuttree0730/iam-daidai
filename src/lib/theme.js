// 主题决策纯函数（2026-09-12 暗色模式）：唯一事实源。
//
// Base.astro <head> 里的内联初始化脚本**无法 import**（必须在首帧前同步执行），
// 那里有一份等价的三行实现——改动决策规则时两处必须同步，回归锁：
// node qa/theme-resolve.test.mjs
//
// 状态打在 :root 的 data-theme 属性上（契约：数值自定义属性不能当 CSS 布尔用，
// 状态判定一律走属性标记）。

export const THEME_KEY = 'theme';

/**
 * @param {string | null | undefined} stored  localStorage 记忆值（可能非法）
 * @param {boolean} prefersDark  系统深色偏好
 * @returns {'dark' | 'light'}
 */
export function resolveTheme(stored, prefersDark) {
  if (stored === 'dark' || stored === 'light') return stored;
  return prefersDark ? 'dark' : 'light';
}

/** 把主题写到根元素的 data-theme 属性上 */
export function applyTheme(root, theme) {
  root.dataset.theme = theme;
}

/** 读当前主题（未标记时按浅色兜底，与初始化脚本一致） */
export function currentTheme(root) {
  return root.dataset.theme === 'dark' ? 'dark' : 'light';
}
