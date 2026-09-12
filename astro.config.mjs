import { existsSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkReadingTime from './src/plugins/remark-reading-time.ts';

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
  integrations: [sitemap()],
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
