import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'post'>;

// 生产构建过滤 draft 与未来日期（定时发布），开发环境全部可见：
// astro build 走 PROD 分支；astro dev 显示完整列表并给草稿打 (草稿)、
// 未来日期文章打 (定时) 标记（标记在 PostCard 内）。
export async function getAllPosts(): Promise<Post[]> {
  const now = Date.now();
  return getCollection('post', ({ data }) => {
    if (import.meta.env.PROD) {
      return !data.draft && data.publishDate.getTime() <= now;
    }
    return !data.draft;
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

/**
 * 置顶精选（2026-09-14 建）：把 featured: true 的文章抽出来单列。
 * 返回 { featured, rest }——两者都保持入参（倒序）的相对顺序。
 * 消费方（列表页）把 featured 放在年份分组之前单独成组：
 *   featured 是「编辑推荐」，不参与时间分组，否则会散落到各自年份里失去置顶意义。
 */
export function splitFeaturedPosts(posts: Post[]): {
  featured: Post[];
  rest: Post[];
} {
  const featured: Post[] = [];
  const rest: Post[] = [];
  for (const p of posts) (p.data.featured ? featured : rest).push(p);
  return { featured, rest };
}

/**
 * 相关文章推荐（2026-09-14 建）：按 tags 的 Jaccard 相似度排序。
 *
 * 相似度 = |交集| / |并集|，取值 [0,1]。乘 100 取整避免浮点误差影响排序稳定。
 *   · 与 tags 数量无关：一篇 10 标签的文章不会仅因为标签多就压过一篇 2 标签
 *     的精准匹配（这是余弦相似度做不到、而 Jaccard 天然免疫的）。
 *   · 完全无交集（相似度 0）的文章**不返回**——宁缺毋滥，页面在结果为空时
 *     整个区块不渲染，而不是塞几条无关的「随便看看」。
 *   · 同分时按发布时间倒序（新的在前），保证构建产物稳定、无随机性。
 *
 * 构建期计算、零运行时成本：只在 getStaticPaths 里对每篇文章各算一次。
 */
export function getRelatedPosts(
  current: Post,
  all: Post[],
  limit = 3,
): Post[] {
  const curTags = new Set(current.data.tags);
  if (curTags.size === 0) return [];

  const scored = all
    .filter((p) => p.id !== current.id)
    .map((p) => {
      const other = new Set(p.data.tags);
      let inter = 0;
      for (const t of curTags) if (other.has(t)) inter++;
      const union = curTags.size + other.size - inter;
      return { post: p, score: union === 0 ? 0 : inter / union };
    })
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.post.data.publishDate.getTime() - a.post.data.publishDate.getTime(),
    );

  return scored.slice(0, limit).map((s) => s.post);
}

/** 档案编号感日期：2026.09.12 */
export function getFormattedDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}
