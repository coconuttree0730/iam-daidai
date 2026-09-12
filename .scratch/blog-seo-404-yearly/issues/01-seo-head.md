# 01 — 全站 SEO 头（canonical + OG + RSS 自动发现）

**What to build:** 布局壳 Props 扩展后，所有页面自动输出 canonical（绝对地址带尾斜杠、中文路径规范编码）与 OG（website/article 两态），文章页附发布/更新时间元数据，全站 head 声明 RSS 端点。
**Blocked by:** None — can start immediately
**Status:** completed（2026-09-12）

- [x] 详情页 og:type=article + article:published_time/modified_time
- [x] 普通页 og:type=website；canonical 全站输出且尾斜杠统一
- [x] 中文标签页 canonical 规范编码（/tags/%E5%89%8D%E7%AB%AF/）
- [x] RSS alternate 声明指向 https://daidai.click/rss.xml
