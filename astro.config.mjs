import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import expressiveCode from 'astro-expressive-code';
import remarkReadingTime from './src/plugins/remark-reading-time.ts';

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

// 纯静态输出：构建产物 dist/ 可直接托管到 Cloudflare Pages / Netlify / Vercel
// 不需要常驻 Node 进程，没有服务端运行时。
//
// vite.cacheDir 的本机覆盖是**条件性的**：只在本机（/home/vii/.tmp 存在）时启用，
// 用来避开本机 safe-delete 拦截 rm 导致的 "Re-optimizing" 卡死。
// 2026-09-11 教训：之前写死成绝对路径，Cloudflare 构建机没有 /home/vii 写权限，
// 直接 EACCES 构建失败。CI 环境走 vite 默认缓存（node_modules/.vite，可写）。
const LOCAL_TMP = '/home/vii/.tmp';

export default defineConfig({
  site: 'https://daidai.click',
  output: 'static',
  integrations: [
    expressiveCode(expressiveCodeOptions),
    sitemap(),
    mdx(),
    pagefindIndexer(),
  ],
  markdown: {
    remarkPlugins: [remarkReadingTime],
  },
  server: {
    host: true,
    port: 4321,
  },
  vite: existsSync(LOCAL_TMP)
    ? { cacheDir: `${LOCAL_TMP}/vite-cache` }
    : {},
});
