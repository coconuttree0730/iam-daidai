import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

function dedupLowercaseTags(array: string[]) {
  return [...new Set(array.map((str) => str.toLowerCase()))];
}

// 博客文章集合（参照 Astro-theme-Cactus-zh_CN 的 schema 精简，2026-09-12）：
// glob loader 扫 src/content/post/**/*.md，post.id = 去扩展名的文件路径。
// schema 精简点：未引入 coverImage（用户裁定「暂不做封面图」），其余字段与 Cactus 对齐。
//
// ── category 与 tags 的语义边界（2026-09-14 定契约，勿混用）────────────────
// · category = **领域**：单选、少而稳、可枚举，是「这篇文章属于哪个方向」。
//   改了要动 URL（/categories/<名>/），因此**当成承诺对待**。
//   典型值：前端 / AI / 工具 / 随笔。分类清单的唯一数据源见 src/data/categories.ts。
// · tags = **具体关键词**：多选、灵活、不拘一格，是「这篇提到了什么」。
//   随手可加、可删，不影响任何固定 URL 的稳定性（标签页由 tags 自动生成）。
// ⚠️ 判定法则：一个词若既像领域又像关键词，问「我会不会用它做目录」——
//   会 → category；只是标记 → tags。两套体系打架的典型症状是同一个词两边都出现。
const post = defineCollection({
  loader: glob({ base: './src/content/post', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string().max(60),
    description: z.string(),
    publishDate: z
      .string()
      .or(z.date())
      .transform((val) => new Date(val)),
    updatedDate: z
      .string()
      .or(z.date())
      .optional()
      .transform((str) => (str ? new Date(str) : undefined)),
    /** 领域分类（单选、可选）。留空即「未分类」，不影响构建——分类骨架先立、
     *  内容后填（2026-09-14 用户裁定）。空字符串会被过滤成 undefined。 */
    category: z
      .string()
      .optional()
      .transform((s) => (s && s.trim() ? s.trim() : undefined)),
    tags: z.array(z.string()).default([]).transform(dedupLowercaseTags),
    /** 置顶精选：true 的文章在列表页最前单独成组（跨年份），不参与年份分组。 */
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { post };
