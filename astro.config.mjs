import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import expressiveCode from 'astro-expressive-code';
import remarkReadingTime from './src/plugins/remark-reading-time.ts';
import rehypeExternalLinks from './src/plugins/rehype-external-links.ts';

// expressive-code 双主题绑定（Cactus 同款契约，2026-09-12 暗色模式）：
// 首个主题决定基准 type，另一枚取相反 type，各自生成 [data-theme='dark'|'light']
// 选择器——代码块随站点主题章整体换肤。
const expressiveCodeOptions = {
  themes: ['github-dark', 'github-light'],
  themeCssSelector: (theme, { styleVariants }) => {
    if (styleVariants.length >= 2) {
      const baseTheme = styleVariants[0]?.theme;
      const altTheme = styleVariants.find(
        (v) => v.theme.type !== baseTheme?.type,
      )?.theme;
      if (theme === baseTheme || theme === altTheme)
        return `[data-theme='${theme.type}']`;
    }
    return `[data-theme="${theme.name}"]`;
  },
  styleOverrides: {
    borderRadius: '6px',
    frames: {
      frameBoxShadowCssValue: 'none',
    },
  },
  useThemedScrollbars: false,
};

// Pagefind 索引挂在 astro:build:done 钩子上，而不是 package.json 的 build
// 脚本链（`&& pagefind --site dist`）：Cloudflare Pages 的构建命令是站点接入
// 时配置的字面 `astro build`，不会跟随 build 脚本的后续追加——2026-09-12
// 事故：该写法只在本地生效，线上 dist 没有 pagefind/，检索永远走 catch。
// 挂进钩子后，CI 跑 `astro build` 或 `npm run build` 都会产出 dist/pagefind/。
function pagefindIndexer() {
  return {
    name: 'pagefind-indexer',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const outDir = typeof dir === 'string' ? dir : fileURLToPath(dir);
        // --no-install：只允许本地安装的 pagefind（npm ci 后必有），
        // 防止 npx 在环境异常时静默远程拉包
        const res = spawnSync(
          'npx',
          ['--no-install', 'pagefind', '--site', outDir],
          { stdio: 'inherit', shell: true },
        );
        if (res.status !== 0) {
          throw new Error(
            `pagefind 索引生成失败（退出码 ${res.status}），检索将不可用`,
          );
        }
        logger.info('pagefind 索引已生成');
      },
    },
  };
}

// ── i18n（2026-09-14 建，方案 A：默认语言无前缀）────────────────────────
//
// 决策依据（用户裁定 + 行业通用做法）：
//   · 子目录架构（而非子域名 / ccTLD）——个人站的默认选择，权威度全部集中在
//     主域，不产生权重分裂。
//   · prefixDefaultLocale: false —— 这是 Astro 的**型别默认值**，也是本次
//     方案的核心：中文地址保持 iam.daidai.click/ 、/works/ 、/blog/ 一字不变，
//     英文挂 /en/ 。避免一次性迁移线上 28 条已收录 URL（含 /tags/前端/ 等
//     三条百分号编码的中文 slug，_redirects 的 :splat 对它们有边界风险）。
//
// ⚠️ 文件结构契约：prefixDefaultLocale: false 时，src/pages/ 根目录
//    **就是中文的家**——不能再建 src/pages/zh/，否则会生成 /zh/... 这个
//    我们不想保留的路径（Astro 要求文件结构与 URL 结构严格对应）。
//    英文页只在 src/pages/en/ 下，中文页原地不动。
//
// ⚠️ 语言切换器不能用「当前路径删/加 /en 前缀」的字符串拼接：中文与英文的
//    URL 层级不对齐（/works/ ↔ /en/works/）。必须走 src/i18n/utils.ts 的
//    显式映射（内部用 getRelativeLocaleUrl 保证与配置同源）。
const SITE_URL = 'https://iam.daidai.click';
const I18N = {
  locales: ['zh', 'en'],
  defaultLocale: 'zh',
  routing: { prefixDefaultLocale: false },
};

// sitemap 的 i18n 选项与上方 I18N 必须同源：它决定 sitemap 里每个 <url>
// 是否输出 <xhtml:link rel="alternate" hreflang>。locales 的值是
// 「locale → hreflang 值」的映射，故 zh 要写成语言-地区形式 zh-CN
// （纯 'zh' 也是合法 hreflang，但 GSC 对带地区的写法报告更细致）。
const SITEMAP_I18N = {
  defaultLocale: I18N.defaultLocale,
  locales: { zh: 'zh-CN', en: 'en' },
};

// 纯静态输出：构建产物 dist/ 可直接托管到 Cloudflare Pages / Netlify / Vercel
// 不需要常驻 Node 进程，没有服务端运行时。
//
// vite.cacheDir 的本机覆盖是**条件性的**：只在本机（/home/vii/.tmp 存在）时启用，
// 用来避开本机 safe-delete 拦截 rm 导致的 "Re-optimizing" 卡死。
// 2026-09-11 教训：之前写死成绝对路径，Cloudflare 构建机没有 /home/vii 写权限，
// 直接 EACCES 构建失败。CI 环境走 vite 默认缓存（node_modules/.vite，可写）。
const LOCAL_TMP = '/home/vii/.tmp';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  i18n: I18N,
  integrations: [
    expressiveCode(expressiveCodeOptions),
    sitemap({ i18n: SITEMAP_I18N }),
    mdx(),
    pagefindIndexer(),
  ],
  markdown: {
    remarkPlugins: [remarkReadingTime],
    /* 外链自动补 target="_blank" + rel + .ext-link 标记（2026-09-14）。
       siteOrigin 取本站 origin，用于「同域绝对 URL 不算外链」的判定——
       硬编码域名换域时会漏，这里从 site 推导（见 plugins/rehype-external-links.ts）。
       ⚠️ Astro.site 在配置对象内尚不可用（就是本对象自己在定义它），
       所以直接写字面量；**改 site 时这一行要同改**。 */
    rehypePlugins: [
      [rehypeExternalLinks, { siteOrigin: 'https://iam.daidai.click' }],
    ],
  },
  server: {
    host: true,
    port: 4321,
  },
  vite: existsSync(LOCAL_TMP)
    ? { cacheDir: `${LOCAL_TMP}/vite-cache` }
    : {},
});
