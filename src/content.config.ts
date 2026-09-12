import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

function dedupLowercaseTags(array: string[]) {
  return [...new Set(array.map((str) => str.toLowerCase()))];
}

// 博客文章集合（参照 Astro-theme-Cactus-zh_CN 的 schema 精简，2026-09-12）：
// glob loader 扫 src/content/post/**/*.md，post.id = 去扩展名的文件路径。
// schema 精简点：未引入 coverImage（当前无配图需求），其余字段与 Cactus 对齐。
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
    tags: z.array(z.string()).default([]).transform(dedupLowercaseTags),
    draft: z.boolean().default(false),
  }),
});

export const collections = { post };
