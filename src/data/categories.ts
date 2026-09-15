/**
 * 领域分类清单（2026-09-14 建）
 * ────────────────────────────────────────────────────────────────────────
 * 这是 category 的**唯一权威清单**，作用有两个：
 *   1. 给 /categories/ 索引页一个稳定顺序（按本数组顺序，不按文章数——分类是
 *      目录，不该因为某类文章多了就往上跳，那是标签的行为）；
 *   2. 给「分类已建但暂无文章」提供表达能力：这里登记、文章还没挂，
 *      索引页也能列出该分类并显示 0 篇（骨架先立、内容后填的落点）。
 *
 * schema 里 category 是可选字符串，**没有**用 z.enum 收口——刻意的：
 *   · 若开发中写了个不在清单里的分类，构建不会红，而是会以「未登记分类」
 *     的身份出现在索引页末尾（见 categories 页面逻辑），一眼可见但不阻断写作；
 *   · 硬 enum 会在你想新开一个分类时必须先改 schema 再写文章，摩擦更大。
 *
 * ⚠️ category 是「承诺」：改名 = 旧 URL 失效（/categories/<名>/）。增删请克制。
 * 与 tags 的边界见 src/content.config.ts 顶部注释。
 */
export interface CategoryDef {
  /** 分类名（即 URL 段 /categories/<name>/，也是 frontmatter 里写的字面值） */
  name: string;
  /** 一句话说明，索引页副标题用 */
  desc: string;
  /** 描边大字（Anton），与 tags/works 板块的英文标签同一视觉语言 */
  en: string;
}

export const CATEGORIES: CategoryDef[] = [
  {
    name: '前端',
    en: 'FRONTEND',
    desc: '页面、构建管线、浏览器行为——写给自己看的实现记录',
  },
  {
    name: 'AI',
    en: 'AI',
    desc: 'Agent、提示工程、与模型协作的实践与踩坑',
  },
  {
    name: '工具',
    en: 'TOOLING',
    desc: '本机环境、命令行、工作流自动化',
  },
  {
    name: '随笔',
    en: 'ESSAY',
    desc: '建站心情、非技术记录、阶段性的想法',
  },
  {
    name: '教程',
    en: 'TUTORIAL',
    desc: '从零到上线的完整步骤，含踩坑与验证方法',
  },
];

/** 取分类定义；未登记的分类返回 undefined（调用方自行决定回退文案） */
export function findCategory(name: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.name === name);
}

/**
 * 排序用的键：已登记分类按清单顺序（0 起），未登记的分类统一排到最后。
 * 索引页与列表页的分组排序共用这一个函数，避免两处各写一份。
 */
export function categoryOrder(name: string): number {
  const i = CATEGORIES.findIndex((c) => c.name === name);
  return i === -1 ? CATEGORIES.length : i;
}
