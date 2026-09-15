// 逐源抓取适配器（取代旧的 HN Algolia 适配器）。
//
// 稳定性的核心在这里：**每个源独立抓取、独立降级**。
// 旧方案是单点（一个 Algolia 端点挂了整轮就跳过），现在六个源里任一失败只损失那一个源，
// 其余照常产出；只有「全部失败」才不写盘、保留上一份快照（规格 D18）。
//
// 不在这里做过滤/排序/截断 —— 那是 pipeline 的职责，本模块只回答
// 「这个源现在能不能拿到条目、拿到了什么」。
import { CONFIG } from '../config.mjs';
import { parseFeed } from './rss.mjs';

// 单源抓取。**永不抛错**：任何异常都折叠成 { ok:false, error }，
// 让调用方按「部分失败」继续，而不是让一个坏源炸掉整轮。
export async function fetchSource({ fetchImpl, source, config = CONFIG }) {
  const base = { id: source.id, label: source.label, lang: source.lang };
  try {
    const res = await fetchImpl(source.url, { signal: AbortSignal.timeout(config.fetchTimeoutMs) });
    if (!res || res.ok !== true) {
      return { ...base, ok: false, error: `http_${res?.status ?? 'no_response'}`, items: [] };
    }
    const text = typeof res.text === 'function' ? await res.text() : '';
    const items = parseFeed(text, { strip: source.strip });
    // 「HTTP 200 但解析出 0 条」也要显式标失败：这通常意味着对方改版或返回了 HTML 页面，
    // 静默当成「今天没新闻」会掩盖真实的坏源。
    if (items.length === 0) {
      return { ...base, ok: false, error: 'no_items_parsed', items: [] };
    }
    return { ...base, ok: true, items };
  } catch (err) {
    const msg = String(err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? err));
    return { ...base, ok: false, error: msg.slice(0, 120), items: [] };
  }
}

// 顺序抓取全部源（不并发：源数量是个位数，顺序抓更礼貌、日志顺序也稳定可读）
export async function fetchAllSources({ fetchImpl, config = CONFIG }) {
  const results = [];
  for (const source of config.sources) {
    results.push(await fetchSource({ fetchImpl, source, config }));
  }
  return results;
}

// 把抓取结果折成可读的一行摘要，供 CLI 输出与测试断言（不含任何敏感信息）
export function describeSources(results) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const parts = ok.map((r) => `${r.id}:${r.items.length}`);
  if (bad.length) parts.push(`失败[${bad.map((r) => `${r.id}=${r.error}`).join(' ')}]`);
  return `${ok.length}/${results.length} 源成功 · ${parts.join(' ')}`;
}
