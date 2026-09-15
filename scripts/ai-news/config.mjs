// 抓取管线全部可调参数集中于此（每张配一行注释说明取值原因）。
// 本文件是纯数据，无副作用；pipeline / run 都从这里取数。
//
// ⚠️ 2026-09-15 站长裁定：数据源从 Hacker News（Algolia API）**整体换成「内容方自营 RSS」**。
//    理由按优先级排序：稳定性 > 安全性 > 合规性 > 内容质量。
//    规格 D15 / D17 原文写的是「唯一数据源 = Hacker News」，已同步修订为「内容方自营 RSS 白名单」。
//    为什么换（三条，均为实测定量结论，详见 SCHEMA.md 与当日日志）：
//      1. 合规：HN 的 YC 使用条款明文禁止 scraping/data mining，且用户内容未授权给第三方；
//         我们过去还存了 HN 用户自撰正文（story_text），是全项目风险最高的一处。
//      2. 稳定：旧方案为了填满 72h 窗，要做「时间切片 + 分页 + 超限递归劈半」；
//         RSS 方案退化为「N 个固定 GET」，无分页、无递归、无 1000 条上限。
//      3. 安全：源全部是「发布者即版权方」的自营 feed（对方主动为分发而发布），
//         且只存 标题 / 链接 / 时间 / 来源 / 摘要（截断），不再存任何用户正文。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  // 时间窗：只保留最近 72 小时内的条目（规格 D11 / D12，本次换源后不变）
  windowHours: 72,

  // 未来时间容差（小时）：源站时间戳偶尔超前于现实（时区标注错误），
  // 若严格拒绝「未来条目」，该源会被整体丢空。
  // 实测 2026-09-15：InfoQ 中文的 pubDate 比现实超前约 6.5h（GMT 标注与实际不符）。
  // 26h = 单日时区误差上限（±12h）+ 余量；再大就说明不是时区问题，应把该源移出白名单。
  futureSlackHours: 26,

  // ── 源白名单：全部为「内容方自己发布」的 RSS/Atom feed ──────────────
  //
  // 收录标准（缺一不可）：
  //   · feed 由内容方自己运营（= 发布者即版权方，发布 feed 的目的就是供订阅/分发）
  //   · 本机与 GitHub Actions 均可达、格式可解析、带可靠 pubDate
  // 字段：id（稳定标识）/ label（界面显示的来源名）/ lang（原文语言，决定页面是否打「未翻译」标）
  //       url / limit（可选，覆盖全局 perSourceLimit）/ strip（可选，剥掉正文前缀噪声）
  //
  // 实测产出（2026-09-15，72h 内条数 / 其中 AI 相关）：
  //   极客公园 30/14 · IT之家 60/14 · 开源中国 50/~14 · 量子位 10/7 · 爱范儿 20/7
  //   arXiv cs.AI 634/346（每日一批公告，全部同一 pubDate）
  // 已考察但不收录：
  //   机器之心 / 36氪 / 品玩 → /rss 返回的是 HTML 页面，不是 feed
  //   雷锋网 502 · InfoQ 中文（时间戳超前 8h、description 恒为「点击查看原文>」7 字）
  //   AWS ML Blog 描述中位 16145 字符、MIT News 6857 字符 → description 实为全文，不宜入库
  sources: [
    { id: 'geekpark', label: '极客公园', lang: 'zh', url: 'https://www.geekpark.net/rss' },
    { id: 'qbitai', label: '量子位', lang: 'zh', url: 'https://www.qbitai.com/feed' },
    { id: 'oschina', label: '开源中国', lang: 'zh', url: 'https://www.oschina.net/news/rss' },
    { id: 'ithome', label: 'IT之家', lang: 'zh', url: 'https://www.ithome.com/rss/' },
    { id: 'ifanr', label: '爱范儿', lang: 'zh', url: 'https://www.ifanr.com/feed' },
    {
      id: 'arxiv',
      label: 'arXiv cs.AI',
      lang: 'en',
      url: 'https://rss.arxiv.org/rss/cs.AI',
      // arXiv 的 description 以「arXiv:2609.13356v1 Announce Type: new Abstract: 」开头，
      // 前缀约 45 字符；摘要上限只有 140，不剥掉等于白扔三分之一配额。
      strip: /^\s*arXiv:\S+\s*Announce Type:\s*\w+\s*Abstract:\s*/i,
      // 同批公告共享同一 pubDate，取太多会在时间线上堆成一个点；4 条足够代表当日 arXiv。
      limit: 4,
    },
  ],

  // AI/ML 关键词白名单：命中其一即视为相关（规格 D16）。按词边界匹配，避免 "ai" 误中 chair/said/air。
  // 中文源必须配中文关键词，否则「大模型 / 算力」这类标题全部漏过。
  // 注意 matchesKeywords 的边界定义是「非字母数字」，中日韩字符天然满足，故中文词可直接收录。
  // 刻意不收「智能」「模型」这类过宽词：会放进智能手表、数据模型等非 AI 内容。
  keywords: [
    // 英文（arXiv 与英文源）
    'ai', 'llm', 'gpt', 'openai', 'anthropic', 'claude', 'gemini', 'deepmind',
    'mistral', 'llama', 'qwen', 'deepseek', 'diffusion', 'midjourney',
    'transformer', 'neural', 'machine learning', 'deep learning',
    'artificial intelligence', 'chatbot', 'copilot', 'agent', 'inference',
    'fine-tune', 'embedding', 'multimodal', 'hugging face', 'open weights',
    'prompt', 'agi',
    // 中文（国内科技媒体）
    '人工智能', '大模型', '语言模型', '开源模型', '基座模型', '智能体', '多模态',
    '生成式', '算力', '智算', '深度学习', '机器学习', '神经网络', '计算机视觉',
    '语音识别', '自动驾驶', '机器人', '芯片', 'aigc',
  ],

  // 每源最多取几条（按发布时间倒序取最新的 N 条）。
  // 取代旧的「热度 × 时间衰减」入选规则 —— RSS 不带热度字段，且站长已裁定顺序按时间。
  // 每源定额同时解决「arXiv 一天 600+ 条会淹没其他源」的均衡问题。
  perSourceLimit: 6,

  // 窗口上限：current.json 恒定 ≤ 30 条（schema §2）
  windowLimit: 30,

  // 摘要入库前的最大字符数。
  // ⚠️ 这条是**安全边界**，不是排版偏好：RSS 的 description 字段装什么由发布方决定，
  // 实测跨度极大（量子位 16 字符的导语 ↔ AWS ML Blog 16145 字符的完整长文）。
  // 不截断就等于「整篇转载」，那是需要授权的行为；截断到一句摘录才落回引用范围。
  summaryMaxChars: 140,

  // 短于此长度的摘要视为「无摘要」（置空串），避免「点击查看原文>」这类导流语占位。
  minSummaryChars: 24,

  // 低于此阈值不写文件、以成功退出（规格 D18 静默失败优先）
  minItems: 5,

  // ── 写盘节流：内容未变则不写（规格 D35）──────────────────────────
  // 顶层 updated 每次写盘都会变，只要写盘就一定产生 git diff。此前每个成功分支都无条件
  // 写盘，导致 workflow 的「无 diff 就跳过提交」恒不触发 —— D35 实际是死代码（2026-09-15
  // 用固定 RSS + 内存 store 实测证实：条目 id 集合完全相同，唯一差异是 updated 一行）。
  // 现在：条目快照与上轮完全一致时**整条不写**，保留旧 updated（= 「内容最后变化的时刻」）。
  //
  // ⚠️ 但这里有一条反向约束：规格 D37 指出「仓库连续 60 天无活动，GitHub 会停用定时任务」，
  // 而缓解手段正是「让任务自己产生提交来续期」。若真碰上源站长期停更（内容一直不变），
  // 节流就会把续期机制一起掐掉。故保留一条兜底：距上次写盘超过本天数时**强制写一次**。
  // 45 天 = 60 天停用门槛留 15 天余量。
  forceWriteAfterDays: 45,

  // 单源抓取的网络超时（毫秒）。RSS 无分页，一次 GET 即全部。
  fetchTimeoutMs: 20_000,

  // 是否启用 GLM 翻译。**默认关闭**：源以中文为主（5 中 + 1 英），
  // 关闭后零第三方数据流、无需 GLM_API_KEY、少一个失败分支（站长优先项：稳定 > 安全 > 内容质量）。
  // 置 true 且注入 GLM_API_KEY 后，逐条标题会发给智谱做翻译。
  translate: false,

  // 数据文件根目录（current.json + archive/），由本目录上溯到 src/data/ai-news
  dataDir: path.resolve(__dirname, '../../src/data/ai-news'),
};
