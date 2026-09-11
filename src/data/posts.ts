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

/** 档案编号感日期：2026.09.12 */
export function getFormattedDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}
