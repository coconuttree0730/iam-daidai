// ── i18n 语言元数据（唯一真相）──────────────────────────────────────────
//
// 本文件只负责「有哪些语言、每种语言对外怎么表达」。
// 路由行为（前缀策略）在 astro.config.mjs 的 i18n 块里，两处**不要互相复制**
// ——这里不重复 prefixDefaultLocale 之类的路由选项。
//
// ⚠️ 消费方一律 import 本文件，不要在页面里写裸字符串 'zh' / 'en'。
//    将来加第三种语言时，唯一要改的是这里（外加 astro.config 的 locales 与
//    src/i18n/ui.ts 的字典树）。

export const LOCALES = ['zh', 'en'] as const;

/** 站点默认语言 = 无 URL 前缀的那个（对应 prefixDefaultLocale: false） */
export const DEFAULT_LOCALE: Locale = 'zh';

export type Locale = (typeof LOCALES)[number];

/** 类型守卫：把来自 URL 的任意字符串收窄成 Locale */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * 每种语言的对外表达。三个字段各有明确归属，不要混用：
 *
 * · `htmlLang`  —— <html lang="..."> 与 hreflang 的语言值。
 *                  zh 用 zh-CN（BCP 47：语言-地区），不用裸 'zh'：
 *                  GSC 对带地区的写法报告更细致，且能避免和 zh-TW 混淆
 *                  （虽然本站目前没有繁体版，写成 zh-CN 是把话说死）。
 * · `ogLocale`  —— og:locale 用下划线分隔（Open Graph 规范要求 zh_CN 而非 zh-CN）。
 * · `label`     —— 语言切换器上显示的短标签，两个字符以内（页头宽度紧张）。
 * · `name`      —— 完整语言名，用于加长标签场景（如 aria-label、下拉菜单）。
 * · `siteName`  —— og:site_name 与 RSS 标题。注意**首页 hero 的站名徽标不读
 *                  这里**（那走 profile.json.site.name，见 SiteMark.astro）；
 *                  本字段只服务「页面之外」的元数据场景。
 */
export const LOCALE_META = {
  zh: {
    htmlLang: 'zh-CN',
    ogLocale: 'zh_CN',
    label: '中',
    name: '中文',
    siteName: 'Daidai 档案馆',
  },
  en: {
    htmlLang: 'en',
    ogLocale: 'en_US',
    label: 'EN',
    name: 'English',
    siteName: 'Daidai Archive',
  },
} as const satisfies Record<Locale, {
  htmlLang: string;
  ogLocale: string;
  label: string;
  name: string;
  siteName: string;
}>;

/** 取某语言的完整元数据；非法值回退默认语言（构建期不抛错，避免炸构建） */
export function localeMeta(locale: string | undefined) {
  return LOCALE_META[isLocale(locale) ? locale : DEFAULT_LOCALE];
}
