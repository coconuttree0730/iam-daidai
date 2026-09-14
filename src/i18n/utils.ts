// ── i18n 工具函数 ───────────────────────────────────────────────────────
//
// 本文件是**所有 i18n 读取的唯一入口**。页面与组件不要直接 import
// ui.ts / LOCALE_META，一律走这里的 useTranslations() / pickLocalized()，
// 这样才能保证「非法 locale → 回退默认语言」的兜底只有一处实现。

import { DEFAULT_LOCALE, LOCALES, isLocale, localeMeta, type Locale } from './config';
import { ui, type UIKey } from './ui';

export { LOCALES, DEFAULT_LOCALE, isLocale, localeMeta };
export type { Locale, UIKey };

/**
 * 取当前 URL 所属语言。
 *
 * 以**路径首段**为准，而不是 Astro.currentLocale：两者在
 * prefixDefaultLocale: false 下结论一致，但本函数不依赖渲染上下文，
 * 在 getStaticPaths、构建期辅助函数里也能直接调用。
 *
 * 注意 `/en` 与 `/en/` 都要认（Astro 产出的目录式路由带尾斜杠，
 * 但 getStaticPaths 拿到的 params 不带）。
 */
export function getLocaleFromPath(pathname: string): Locale {
  const first = pathname.split('/').filter(Boolean)[0];
  return isLocale(first) && first !== DEFAULT_LOCALE ? first : DEFAULT_LOCALE;
}

/**
 * 回退链：缺失 → 默认语言 → 键名本身。
 *
 * 最后一层「返回键名」是刻意的：构建期就把缺失暴露出来（页面上会直接
 * 印出 `section.foo.title` 这种字符串），比静默显示空白更容易发现。
 * 生产环境宁可显示丑，也不要显示空——空白会被当成版式问题排查半天。
 */
export function useTranslations(locale: Locale) {
  const dict = ui[locale] ?? ui[DEFAULT_LOCALE];
  return function t(key: UIKey): string {
    return dict[key] ?? ui[DEFAULT_LOCALE][key] ?? key;
  };
}

/**
 * 占位符插值：把 `{name}` 替换成传入的值。
 *
 * 为什么不用模板字符串拼：i18n 文案里带变量时，语序在两种语言里可能不同
 * （中文「约 5 分钟」/ 英文 "5 min read"），把整句放进字典、变量留在
 * `{n}` 里，才能让翻译者自由调整语序。拼字符串做不到这点。
 *
 * 未提供的键保持原样（`{n}` 原样印出）——同样是「构建期暴露问题」的取向。
 */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * 双语字段取值。
 *
 * 数据源里「需要翻译的字段」写成 `{ zh: '作品集', en: 'Works' }`，
 * 「不该翻译的字段」（数值、编号、标识符）保持原样——本函数检查到
 * 非双语对象就**原样返回**，因此天然豁免以下字段，无需逐个标注：
 *
 *   · profile.cards[].theta      → 数字（hero.css 版式契约 ±46/±22）
 *   · profile.cards[].lookFrame  → 数字（帧序号）
 *   · profile.infoBar[].value    → 'NO.001' / 'OPEN TO WORK'（标识符）
 *   · profile.works.items[].no   → '01'（详情页 slug 的来源）
 *   · profile.works.cats[].letter → 'A'（卷宗侧签字母）
 *   · 任意 string[] / boolean / null
 *
 * 判定条件是「对象且同时含 zh 与 en 两个键」，因此含单个 `en` 字段的
 * 对象（如 profile.works.cats[].en 是对照用英文名，不是翻译）不会被
 * 误判——这是与 lab.json 既有 `en` 字段惯例如共存的关键。
 */
export function pickLocalized<T>(value: T | Record<Locale, T>, locale: Locale): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'zh' in (value as object) &&
    'en' in (value as object)
  ) {
    const bag = value as Record<Locale, T>;
    return bag[locale] ?? bag[DEFAULT_LOCALE];
  }
  return value as T;
}

/**
 * 生成「同一页面的另一种语言」的 URL —— 语言切换器的唯一实现。
 *
 * ⚠️ **不要用字符串拼接**（如 `pathname.replace(/^\/en/, '')`）：
 * prefixDefaultLocale: false 下两种语言的 URL 层级不对齐
 * （/works/01/ ↔ /en/works/01/），拼接式替换在带深度的路由上极易出错，
 * 且会把 /tags/前端/ 这类百分号编码路径弄坏。
 *
 * 这里用**显式映射**：去掉当前语言前缀拿到「语言无关路径」，再按目标
 * 语言重新加前缀。因为本站只有两种语言、且默认语言无前缀，映射表可以
 * 写死；将来加到三种语言时，把 mapping 换成 astro:i18n 的
 * getRelativeLocaleUrl() 即可（见文件末尾注释）。
 *
 * @param pathname 当前页面路径，如 '/en/works/01/'
 * @param target   目标语言
 */
export function switchLocalePath(pathname: string, target: Locale): string {
  // 1. 剥掉当前语言前缀，得到语言无关路径（始终以 / 开头）
  const current = getLocaleFromPath(pathname);
  let bare = pathname;
  if (current !== DEFAULT_LOCALE) {
    bare = pathname.replace(new RegExp(`^/${current}(?=/|$)`), '');
  }
  if (!bare.startsWith('/')) bare = `/${bare}`;
  // 尾斜杠统一保留（构建产物是目录式路由，canonical 也统一补尾斜杠）
  if (!bare.endsWith('/')) bare = `${bare}/`;

  // 2. 按目标语言重新加前缀
  if (target === DEFAULT_LOCALE) return bare;
  return bare === '/' ? `/${target}/` : `/${target}${bare}`;
}
