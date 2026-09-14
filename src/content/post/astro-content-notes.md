---
title: Astro 内容集合速记
description: 从 Cactus 主题学来的内容管线：glob loader、zod schema、草稿过滤，一份给自己看的备忘。
publishDate: 2026-09-12
updatedDate: 2026-09-13
category: 前端
tags: ["astro"]
---

博客板块的内容管线参考了 [Astro-theme-Cactus-zh_CN](https://github.com/zouzonghao/Astro-theme-Cactus-zh_CN) 的实现，这里记一份要点。

## 集合定义

`src/content.config.ts` 里用 glob loader 扫描 Markdown，zod 负责校验 frontmatter：

```ts
const post = defineCollection({
  loader: glob({ base: './src/content/post', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string().max(60),
    description: z.string(),
    publishDate: z.string().or(z.date()).transform((val) => new Date(val)),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});
```

## 三个值得记住的细节

| 机制 | 作用 |
| --- | --- |
| `import.meta.env.PROD` | 生产构建过滤草稿，开发环境照常可见 |
| `post.id` | Content Layer 下等价于旧版的 `slug`，直接拼路由 |
| `paginate()` | Astro 内置分页，不用自己切数组 |

## 卡片组件

Cactus 的 `PostPreview` 总共 26 行，没有一行客户端 JS——「卡片」其实是 `日期列 + 标题链接` 的行式条目，视觉重心全靠排版而不是盒子。这个思路很适合本站的线稿风格。
