import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'post'>;

// 生产构建过滤 draft，开发环境全部可见（与 Cactus 主题同款行为）：
// astro build 走 PROD 分支，astro dev 走完整列表并给草稿打 (草稿) 标记。
export async function getAllPosts(): Promise<Post[]> {
  return getCollection('post', ({ data }) => {
    return import.meta.env.PROD ? !data.draft : true;
  });
}

/** 按发布时间倒序（新文章在前） */
export function collectionDateSort(a: Post, b: Post): number {
  return b.data.publishDate.getTime() - a.data.publishDate.getTime();
}

/**
 * 取全部已发布文章（生产过滤 draft）并按发布时间倒序。
 * 路由 getStaticPaths 的标准入口——封装「过滤 + 排序」两步，
 * 让消费方只导入一个绑定（绕开 Astro 7.3.2 合并导入丢绑定的编译 bug，
 * 2026-09-12 实测：blog/[...id] 同时导入 4 个命名绑定时第 4 个被丢）。
 */
export async function getSortedPosts(): Promise<Post[]> {
  const posts = await getAllPosts();
  return [...posts].sort(collectionDateSort);
}

/**
 * 按年分组（2026-09-12 票04）：入参须为已倒序文章列表。
 * 返回 [年份, 文章数组] 的有序列表——年份降序、组内保持入参倒序。
 * 仅承担数据组织；页内视觉分隔、跨页连续编号由消费方（列表页）处理。
 */
export function groupPostsByYear(posts: Post[]): Array<[number, Post[]]> {
  const map = new Map<number, Post[]>();
  for (const post of posts) {
    const year = post.data.publishDate.getFullYear();
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(post);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
}

/** 档案编号感日期：2026.09.12 */
export function getFormattedDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}
