// ── UI 字符串字典 ───────────────────────────────────────────────────────
//
// 范围约定（重要）：**这里只放「界面文案」，不放「你的内容」。**
//
//   ✓ 放这里：导航项、按钮、返回链、aria-label、空态提示、表单标签、
//             组件 tooltip、脚本运行时提示（toast）
//   ✗ 不放这里：hero 大字与四卡菜单名 → src/data/profile.json
//               公告条目       → src/data/announcements.json
//               游乐场条目说明 → src/data/lab.json
//               作品描述 / 文章正文 → profile.json / src/content/post/
//
// 为什么用扁平点号键（而非嵌套对象树）：key 用字符串字面量类型，拼错在
// `astro check` 阶段就被 TS 拦住；嵌套树需要递归推导，收益不抵复杂度。
//
// ⚠️ 两个语言的键集合必须**完全一致**（下面的 satisfies 会强制这件事）。
//
// ⚠️ 第 2 期（2026-09-14）把原先**硬编码在各组件里**的界面文案全部收编到这里
//    —— 原因：那些字符串在中英文共用同一个组件，没有 locale 输入就没有切换
//    能力。收编后组件只负责渲染，文案的唯一来源是这里。
//
// ⚠️ 支持 `{name}` 占位符的键（用 utils 的 `interpolate` 消费）：
//    hero.figureAria / basic.foot / contact.err /
//    post.minutes / post.updated
//    （blog.noResult / blog.count 已移出：它们唯一消费方是 Pagefind UI 的
//      translations，那里只认 [SEARCH_TERM]/[COUNT] 令牌，不经过 interpolate
//      ——2026-09-15 修正：此前写成 {term}/{n}，线上零结果/结果计数会印出
//      字面占位符。）

import type { Locale } from './config';

export const ui = {
  zh: {
    // ── 站点 ──
    'site.title': 'Daidai档案馆',

    // ── 页头控件 ──
    'head.backHome': '← 返回档案馆',
    'head.backBlog': '← 返回博客',
    'head.backWorks': '← 返回作品集',
    'head.backTags': '← 返回标签索引',
    'head.backLab': '← 返回游乐场',
    /** 语言切换器：当前语言下的按钮标题（点了会去另一种语言） */
    'head.switchTo': '切换到 English',

    // ── 首页四卡（全站导航）── 展示文案在 profile.json.cards，这里是兜底 ──
    'nav.basic': '关于我...',
    'nav.works': '作品集',
    'nav.blog': '博客',
    'nav.lab': '游乐场',

    // ── 板块页头 ──
    'section.works.title': '作品集',
    'section.works.desc': '作品集板块 · 精选项目档案',
    'section.blog.title': '博客',
    'section.blog.desc': '博客板块 · 文章归档',
    'section.lab.title': '游乐场',
    'section.lab.desc': '游乐场板块 · 交互实验与教材，每个条目都附可运行的原始演示',
    'section.tags.title': '标签索引',
    'section.tags.desc': '博客板块 · 全部标签归档',

    // ── 空态 / 状态 ──
    'empty.archiving': '档案整理中',
    'empty.archivingNote': 'ARCHIVING · 该板块即将开放',
    'empty.noTags': '暂无标签',
    'empty.noTagsNote': 'NO TAGS · 文章归档后在此建立索引',

    // ── 语言切换器自身 ──
    'lang.switchLabel': '语言',

    // ── 分页器（Paginator.astro）──
    'pager.nav': '分页导航',
    'pager.prev': '上一页',
    'pager.next': '下一页 →',

    // ── 文章目录（ArticleToc.astro）──
    'toc.title': '目录 / INDEX',
    'toc.aria': '文章目录',
    'toc.close': '关闭目录',
    'toc.open': '打开目录',

    // ── 公告（Announce.astro）──
    'announce.button': '公告',
    'announce.pinned': '置顶',
    'announce.aria': '公告',
    'announce.more': '查看详情',

    // ── 昼夜章（ThemeToggle.astro）──
    'theme.toggle': '切换日间 / 夜间模式',
    'theme.title': '切换日 / 夜览',

    // ── 回顶绳（TopRope.astro）──
    'rope.pull': '按住下拉，回到页面顶部',
    'rope.title': '按住下拉 · 回到顶部',

    // ── 右下悬浮栈（ScrollDock.astro）──
    'dock.top': '回到顶部',
    'dock.toc': '文章目录',
    'dock.bottom': '滚到底部',
    'dock.music': '音乐播放',
    'dock.musicSoon': '音乐（待接入）',

    // ── 首页 hero ──
    'hero.fanAria': '档案目录',
    'hero.figureAria': '鼠标跟随人物立绘，共 {n} 帧',

    // ── 基本信息抽屉（BasicDrawer.astro）──
    'basic.dialogTitle': '基本信息档案',
    'basic.fileHeadLabel': 'PERSONAL FILE',
    'basic.close': '合卷',
    'basic.photoCaption': 'FIG.01 — 档案照',
    'basic.photoStamp': '已归档',
    'basic.labelSkills': 'INDEX · 技能',
    'basic.labelIdentity': 'IDENTITY · 身份',
    'basic.labelNow': 'NOW · 正在做',
    'basic.labelPersona': 'PERSONA · 性格侧写',
    'basic.foot': 'FILE {no} · ARCHIVED',

    // ── 联系表单（ContactForm.astro）──
    'contact.pending': '正在发送…',
    'contact.ok': '已发送，我会尽快回复。',
    'contact.errNetwork': '网络异常',
    'contact.err': '发送失败（{msg}），请稍后再试。',
    'contact.consentError': '请先勾选同意后再发送。',
    'contact.sending': '发送中…',

    // ── 实验室页（lab.astro）──
    'lab.heroTitle': '实验与教材',
    'lab.heroSub': '把做过的东西拆开讲 · 每个条目都附可交互的原始演示',
    'lab.building': '持续扩建中',
    'lab.buildingNote': 'IN PROGRESS · 新条目陆续归档',
    'lab.entryCount': '收录 {n} 项',

    // ── 游乐场板块 tab 条 + AI 新闻页（2026-09-15，LAB-NEWS）──
    // 范围提醒：**新闻内容本身不进字典**（它是数据，见 src/data/ai-news/）——
    // 这里只放界面控件与结构文案。`{time}` / `{period}` / `{year}` 由页面用
    // Intl.DateTimeFormat 按 locale 生成，故字典里不列月份名。
    'lab.tabsAria': '游乐场板块切换',
    'lab.tabExperiments': '实验',
    'lab.tabNews': '新闻',
    'section.news.title': 'AI 新闻',
    'section.news.desc': '游乐场板块 · AI 领域外部新闻时间线，英文原文配中文摘要',
    'news.heroSub': '外部信息入口 · 按天排列，可回看的历史时间线',
    'news.timelineAria': '新闻时间线',
    'news.empty': '时间线还是空的',
    'news.emptyNote': 'TIMELINE EMPTY · 下一次抓取完成后，条目会出现在这里',
    'news.emptyEnOnly':
      'TIMELINE EMPTY · 英文页只收录原文为英文的条目，中文源条目请见中文版时间线',
    'news.updated': '最后更新 {time}',
    'news.neverFetched': '尚未抓取',
    'news.untranslated': '未翻译',
    'news.itemAria': '{title} · 来源 {source} · {time}',
    'news.yearNav': '年份',
    'news.yearLink': '{year} 年',
    'news.periodAria': '{period} 的条目',

    // ── 标签索引页（tags/index.astro）──
    'tags.list': '标签列表',

    // ── 作品集页（works.astro）──
    'works.end': '完',
    'works.coming': '敬请期待',
    'works.endCta': '有想一起做的项目？',
    'works.scrollHint': '滚动查看作品',

    // ── 作品详情页 ──
    'work.prev': '上一件',
    'work.next': '下一件',
    'work.gotoHome': '回到首页体验 →',
    'work.gotoGithub': 'GitHub 仓库 →',
    'work.gotoProject': '访问项目 →',
    'work.notArchived': '尚未归档 · 敬请期待',
    'work.pnAria': '上一篇 / 下一篇',

    // ── 博客列表页（blog/[...page].astro）──
    'blog.search': '站内全文检索',
    'blog.searchPlaceholder': '检索文章全文…',
    'blog.clear': '清空',
    'blog.clearAria': '清空检索',
    'blog.searching': '检索中…',
    'blog.searchErr': '检索出错，请重试',
    'blog.noResult': '没有与「[SEARCH_TERM]」匹配的结果',
    'blog.count': '[COUNT] 个结果 ·「[SEARCH_TERM]」',
    'blog.filter': '过滤',
    'blog.loadMore': '加载更多',
    'blog.listAria': '文章列表',
    'blog.chipTags': '标签',

    // ── 博客详情页 ──
    'post.notes': 'NOTES',
    'post.minutes': '约 {n} 分钟',
    'post.updated': '更新于 {d}',
    'post.navAria': '相邻文章',
    'post.newer': '← 上一篇（更新）',
    'post.older': '下一篇（更旧） →',
    'post.archiveChip': '归档',

    // ── 文章页操作条（PostActions.astro，2026-09-14 收编硬编码文案）──
    'post.actionsAria': '分享与订阅',
    'post.copy': '复制链接',
    'post.copied': '已复制',
    'post.copyFail': '复制失败',
    'post.share': '分享',
    'post.subscribe': '订阅更新',
    'post.noscriptCopy': '复制此链接分享：',

    // ── 分类索引页（/categories/ 与 /en/categories/ 共用，2026-09-14 英文档补齐）──
    'section.cats.title': '分类',
    'section.cats.desc': '博客板块 · 按领域归档',
    'cats.index': '索引',
    'cats.chipAllTags': '全部标签',
    'cats.chipAll': '全部分类',
    'cats.back': '← 返回分类索引',
    'cats.listAria': '分类列表',
    'cats.detailAria': '分类 {name} 的文章列表',
    'cats.none': '暂无分类',
    'cats.noneNote': 'NO CATEGORIES · 建站方向确定后在此登记',
    'cats.uncategorized': '未登记分类 · 请在 src/data/categories.ts 补充说明',
    'cats.lede':
      '已归类 {a} / {b} 篇 ',
    'cats.count': '{n} 篇',
    'cats.empty': '暂无文章',
    'cats.emptyNote': 'EMPTY · 这个方向还没开始写',
    'cats.fallbackNote': '分类名与说明跟随文章语言（中文），界面外壳为英文。',

    // ── 无障碍（Base.astro 键盘跳转链接）──
    'a11y.skip': '跳到正文',

    // ── 404 ──
    'notfound.title': '档案不存在',
    'notfound.desc': '你要找的页面不在这个档案馆里。',
    'notfound.home': '← 回到档案馆',

    // ── 游乐场滚动演示页（lab/scroll.astro）──
    'scroll.backLab': '← 返回游乐场',
    'scroll.close': '关闭',
    'scroll.heroTitle': '滚动帧随动',
    'scroll.viewPrinciple': '查看原理说明',
    'scroll.params': '实时参数',
    'scroll.scrollHint': '↑ 在手机内滚动 ↓',
  },

  en: {
    // ── Site ──
    'site.title': 'Daidai Archive',

    // ── Page head controls ──
    'head.backHome': '← Back to archive',
    'head.backBlog': '← Back to blog',
    'head.backWorks': '← Back to works',
    'head.backTags': '← Back to tags',
    'head.backLab': '← Back to playground',
    'head.switchTo': 'Switch to 中文',

    // ── Home four cards (site-wide nav) ──
    'nav.basic': 'About me...',
    'nav.works': 'Works',
    'nav.blog': 'Blog',
    'nav.lab': 'Playground',

    // ── Section heads ──
    'section.works.title': 'Works',
    'section.works.desc': 'Selected projects and case files',
    'section.blog.title': 'Blog',
    'section.blog.desc': 'Posts and notes, archived',
    'section.lab.title': 'Playground',
    'section.lab.desc': 'Interactive experiments and write-ups, each with a runnable demo',
    'section.tags.title': 'Tags',
    'section.tags.desc': 'All tags used across the blog',

    // ── Empty / status ──
    'empty.archiving': 'Archiving',
    'empty.archivingNote': 'This section is opening soon',
    'empty.noTags': 'No tags yet',
    'empty.noTagsNote': 'Tags are indexed here once posts are archived',

    // ── Language switcher ──
    'lang.switchLabel': 'Language',

    // ── Paginator ──
    'pager.nav': 'Pagination',
    'pager.prev': 'Previous',
    'pager.next': 'Next →',

    // ── Table of contents ──
    'toc.title': 'CONTENTS',
    'toc.aria': 'Table of contents',
    'toc.close': 'Close contents',
    'toc.open': 'Open contents',

    // ── Announcements ──
    'announce.button': 'Notices',
    'announce.pinned': 'Pinned',
    'announce.aria': 'Notices',
    'announce.more': 'Read more',

    // ── Theme toggle ──
    'theme.toggle': 'Switch between day and night mode',
    'theme.title': 'Day / night',

    // ── Scroll-to-top rope ──
    'rope.pull': 'Press and pull down to return to top',
    'rope.title': 'Pull down · back to top',

    // ── Bottom-right dock ──
    'dock.top': 'Back to top',
    'dock.toc': 'Table of contents',
    'dock.bottom': 'Scroll to bottom',
    'dock.music': 'Music player',
    'dock.musicSoon': 'Music (coming soon)',

    // ── Home hero ──
    'hero.fanAria': 'Archive index',
    'hero.figureAria': 'Cursor-following figure, {n} frames',

    // ── Basic info drawer ──
    'basic.dialogTitle': 'Basic information file',
    'basic.fileHeadLabel': 'PERSONAL FILE',
    'basic.close': 'Close file',
    'basic.photoCaption': 'FIG.01 — File photo',
    'basic.photoStamp': 'ARCHIVED',
    'basic.labelSkills': 'INDEX · Skills',
    'basic.labelIdentity': 'IDENTITY · Who I am',
    'basic.labelNow': 'NOW · Current focus',
    'basic.labelPersona': 'PERSONA · Personality',
    'basic.foot': 'FILE {no} · ARCHIVED',

    // ── Contact form ──
    'contact.pending': 'Sending…',
    'contact.ok': 'Sent. I will get back to you soon.',
    'contact.errNetwork': 'network error',
    'contact.err': 'Failed to send ({msg}). Please try again later.',
    'contact.consentError': 'Please tick the consent box before sending.',
    'contact.sending': 'SENDING…',

    // ── Lab page ──
    'lab.heroTitle': 'Experiments & Write-ups',
    'lab.heroSub': 'Taking things apart — every entry ships with a runnable demo',
    'lab.building': 'Under construction',
    'lab.buildingNote': 'IN PROGRESS · new entries being archived',
    'lab.entryCount': '{n} entries',

    // ── Playground tab bar + AI news page (2026-09-15, LAB-NEWS) ──
    // Key set is mirrored 1:1 with the `zh` bag above — the `satisfies` check
    // at the bottom of this file fails the build on any asymmetry.
    'lab.tabsAria': 'Playground sections',
    'lab.tabExperiments': 'Lab',
    'lab.tabNews': 'News',
    'section.news.title': 'AI News',
    'section.news.desc': 'Playground · a timeline of AI news from around the web',
    'news.heroSub': 'An external feed — grouped by day, browsable back through time',
    'news.timelineAria': 'News timeline',
    'news.empty': 'The timeline is empty',
    'news.emptyNote': 'TIMELINE EMPTY · entries appear here after the next fetch',
    'news.emptyEnOnly':
      'TIMELINE EMPTY · this page lists English-language sources only — see the Chinese timeline for the rest',
    'news.updated': 'Last updated {time}',
    'news.neverFetched': 'Not fetched yet',
    'news.untranslated': 'Untranslated',
    'news.itemAria': '{title} · {source} · {time}',
    'news.yearNav': 'Year',
    'news.yearLink': '{year}',
    'news.periodAria': 'Entries from {period}',

    // ── Tags index page ──
    'tags.list': 'Tag list',

    // ── Works page ──
    'works.end': 'FIN',
    'works.coming': 'COMING SOON',
    'works.endCta': 'Got something to build together?',
    'works.scrollHint': 'Scroll to see the stack',

    // ── Work detail page ──
    'work.prev': 'Previous',
    'work.next': 'Next',
    'work.gotoHome': 'Open the live site →',
    'work.gotoGithub': 'GitHub repository →',
    'work.gotoProject': 'Visit project →',
    'work.notArchived': 'Not archived yet · coming soon',
    'work.pnAria': 'Previous / next work',

    // ── Blog list page ──
    'blog.search': 'Search this site',
    'blog.searchPlaceholder': 'Search posts…',
    'blog.clear': 'Clear',
    'blog.clearAria': 'Clear search',
    'blog.searching': 'Searching…',
    'blog.searchErr': 'Search failed, please retry',
    'blog.noResult': 'No results for “[SEARCH_TERM]”',
    'blog.count': '[COUNT] results · “[SEARCH_TERM]”',
    'blog.filter': 'Filter',
    'blog.loadMore': 'Load more',
    'blog.listAria': 'Post list',
    'blog.chipTags': 'Tags',

    // ── Post detail page ──
    'post.notes': 'NOTES',
    'post.minutes': '{n} min read',
    'post.updated': 'Updated {d}',
    'post.navAria': 'Adjacent posts',
    'post.newer': '← Newer',
    'post.older': 'Older →',
    'post.archiveChip': 'Archive',

    // ── Post actions bar (PostActions.astro, hardcoded strings collected 2026-09-14) ──
    'post.actionsAria': 'Share and subscribe',
    'post.copy': 'Copy link',
    'post.copied': 'Copied',
    'post.copyFail': 'Copy failed',
    'post.share': 'Share',
    'post.subscribe': 'Subscribe via RSS',
    'post.noscriptCopy': 'Copy this link to share:',

    // ── Categories pages (/categories/ + /en/categories/, added with the EN shell 2026-09-14) ──
    'section.cats.title': 'Categories',
    'section.cats.desc': 'Blog · posts grouped by domain',
    'cats.index': 'Index',
    'cats.chipAllTags': 'Tags',
    'cats.chipAll': 'All categories',
    'cats.back': '← Back to categories',
    'cats.listAria': 'Category list',
    'cats.detailAria': 'Posts in category {name}',
    'cats.none': 'No categories',
    'cats.noneNote': 'NO CATEGORIES · domains appear here once registered',
    'cats.uncategorized': 'Unregistered · document it in src/data/categories.ts',
    'cats.lede':
      '{a} of {b} posts categorized · Categories are domains, tags are keywords — two parallel ways in',
    'cats.count': '{n} posts',
    'cats.empty': 'No posts yet',
    'cats.emptyNote': 'EMPTY · nothing filed under this domain yet',
    'cats.fallbackNote':
      'Category names and descriptions follow the language of the posts (Chinese).',

    // ── Accessibility (keyboard skip link in Base.astro) ──
    'a11y.skip': 'Skip to content',

    // ── 404 ──
    'notfound.title': 'File not found',
    'notfound.desc': 'The page you are looking for is not in this archive.',
    'notfound.home': '← Back to archive',

    // ── Lab scroll demo page ──
    'scroll.backLab': '← Back to playground',
    'scroll.close': 'Close',
    'scroll.heroTitle': 'Scroll-driven frames',
    'scroll.viewPrinciple': 'How it works',
    'scroll.params': 'Live parameters',
    'scroll.scrollHint': '↑ Scroll inside the phone ↓',
  },
} as const satisfies Record<Locale, Record<string, string>>;

/**
 * 全部合法键的联合类型。
 *
 * 用 `keyof (typeof ui)['zh']` 而不是 `keyof typeof ui[Locale]`：
 * 直接取某一门语言的键集合作基准即可，`satisfies` 已保证两门语言的键
 * **完全一致**（少一个键、多一个键都会在构建时被 TS 拦下）。
 */
export type UIKey = keyof typeof ui.zh;
