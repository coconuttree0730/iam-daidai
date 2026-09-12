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
 * 默认昼（2026-09-12 用户裁定）：首次访问（无合法记忆值）一律浅色，
 * 系统深色偏好不再参与决策——只有游客点「夜」写入记忆后才切黑。
 *
 * @param {string | null | undefined} stored  localStorage 记忆值（可能非法）
 * @param {boolean} [prefersDark]  已废弃：保留形参避免调用点断裂，恒被忽略
 * @returns {'dark' | 'light'}
 */
export function resolveTheme(stored, prefersDark) {
  if (stored === 'dark' || stored === 'light') return stored;
  return 'light';
}

/** 把主题写到根元素的 data-theme 属性上 */
export function applyTheme(root, theme) {
  root.dataset.theme = theme;
}

/** 读当前主题（未标记时按浅色兜底，与初始化脚本一致） */
export function currentTheme(root) {
  return root.dataset.theme === 'dark' ? 'dark' : 'light';
}
