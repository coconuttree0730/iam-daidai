// 文本相关纯函数：关键词命中、时间窗判定。可单测。
//
// 旧版还有 heatOf / scoreOf（HN「热度 × 时间衰减」排序）。换源后 RSS 不带热度字段，
// 且站长已裁定窗口顺序 = 时间倒序，入选规则改为「每源定额」，两个函数已无调用方，故删除
// —— 留着会让人误以为热度仍在参与决策。
import { CONFIG } from '../config.mjs';

// 正则转义，避免关键词里的 . + 等被当作元字符
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 关键词匹配：按词边界，避免 "ai" 误中 chair / said / air（规格 D16 正确性陷阱）。
// 边界 = 行首 / 行尾 / 「非字母数字」字符。中日韩字符天然属于「非字母数字」，
// 所以中文关键词（大模型、算力…）用同一套规则即可正确命中，不需要单独的匹配路径。
export function matchesKeywords(text, keywords = CONFIG.keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    const k = kw.toLowerCase();
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(k)}(?:[^a-z0-9]|$)`, 'i');
    return re.test(lower);
  });
}

// 是否落在时间窗内：anchor = publishedAt ?? fetchedAt（schema §5）。
// 缺失 / 不可解析 → 窗外。
//
// futureSlackHours 是为**源站时间戳超前**准备的口子：实测 InfoQ 中文的 pubDate 比现实
// 超前约 6.5h。若严格要求 age >= 0，这类源会被整体丢空，而且表现与「今天没新闻」无法区分。
// 容忍上限见 config.futureSlackHours（26h ≈ 单日时区误差）。
export function withinWindow(item, now, hours = CONFIG.windowHours, futureSlackHours = 0) {
  const ts = item?.publishedAt ?? item?.fetchedAt;
  if (!ts) return false;
  const ageHours = (now.getTime() - new Date(ts).getTime()) / 3_600_000;
  if (Number.isNaN(ageHours)) return false;
  return ageHours <= hours && ageHours >= -futureSlackHours;
}

// 锚点时间戳（毫秒）；不可解析返回 -Infinity（排序时视为最旧，见 pipeline 的排序说明）
export function anchorMs(item) {
  const ts = item?.publishedAt ?? item?.fetchedAt;
  if (!ts) return -Infinity;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}
