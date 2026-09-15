// 把源条目塑造成 NewsItem（schema §4）。
//
// 与旧版的本质区别：旧版的数据源是 HN，条目里带了 `story_text`（HN 用户自撰正文）和
// `points/num_comments`（热度）；新版源是内容方自营 RSS，**既没有热度字段，也不该存正文**。
// 因此本版：
//   · 不再产出 `heat`（热度是 HN 特有的，RSS 无此信号；入选规则已改为「每源定额 + 时间倒序」）
//   · 不再产出 `translated`（2026-09-15 站长裁定：本管线不接入任何 LLM，没有翻译环节）
//   · `summary` 一律**截断**（安全边界，见 config.summaryMaxChars 的注释）
//   · 新增 `lang`（原文语言），供页面判断是否要打「未翻译」标
import { urlKey } from './url.mjs';

// 摘要截断。用 slice 而不是「按句子切」：RSS 摘要常无句读（如「打破分子模拟不可能三角」），
// 按句切会整段丢掉。截断后**不补省略号**——保持它是原文的忠实前缀，不掺入我们的字符。
export function truncateSummary(text, maxChars) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  return s.length <= maxChars ? s : s.slice(0, maxChars).trimEnd();
}

export function shapeItem(raw, { fetchedAt, sourceLabel, lang, config }) {
  const url = String(raw?.url ?? '').trim();
  const title = String(raw?.title ?? '').trim();

  // 摘要：先截断到安全上限；短于 minSummaryChars 的视为「无摘要」置空串，
  // 避免「点击查看原文>」这类导流语占用版面（实测 InfoQ 中文的 description 恒为 7 字符）。
  let summary = truncateSummary(raw?.summary, config.summaryMaxChars);
  if (summary.length < config.minSummaryChars) summary = '';

  // publishedAt：源发布时间；非法/缺失置 null（schema §4 允许缺，上层按 §5 回退 fetchedAt）
  const publishedAt = raw?.publishedAt && !Number.isNaN(new Date(raw.publishedAt).getTime())
    ? raw.publishedAt
    : null;

  return {
    id: urlKey(url), // 去重主键 = 规范化 URL 的短哈希
    url, // string，绝对 URL（原样未规范化，它是给读者点的）
    source: sourceLabel, // 来源名，界面直接显示
    lang, // 'zh' | 'en'：原文语言
    // 两个语言槽同值：数据 = 源站原文，本管线不做翻译（D7 降级不产生空字段的延伸——
    // 宁可两槽都显示原文，也不给空标题）。页面按 lang 门控，不会把同一句印两遍。
    title: { en: title, zh: title },
    summary: { en: summary, zh: summary },
    publishedAt,
    fetchedAt,
  };
}
