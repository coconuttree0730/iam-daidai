// 离线抓取管线编排器。
// 冻结签名（ticket 05 直接调用，不改本文件）：
//   runPipeline({ fetchImpl, now, config, store, rollover })
//
// ⚠️ 2026-09-15 换源：抓取段从「HN Algolia：时间切片 + 分页 + 超限递归劈半」换成
// 「内容方自营 RSS：逐源一次 GET」。整条管线因此显著变短 —— 这不是简化美学，
// 而是站长把「稳定性」列为第一优先项后的直接结果：请求数从「5~40 次 + 递归」降到 6 次固定，
// 没有分页、没有 1000 条上限、没有递归深度这类会随源站负载变化的失败路径。
//
// ⛔ 本管线**不含任何 LLM 环节**（2026-09-15 站长裁定）：曾有的 `enrich` 钩子（GLM 翻译）
// 已整条删除，数据 = 源站原文，零第三方数据流。别再引入，理由见 config.mjs / SCHEMA.md §8。
import { describeSources, fetchAllSources } from './lib/source.mjs';
import { shapeItem } from './lib/shape.mjs';
import { anchorMs, matchesKeywords, withinWindow } from './lib/text.mjs';
import { realStore } from './lib/store.mjs';
import { CONFIG } from './config.mjs';

// 窗口**输出顺序**契约（SCHEMA §3）：按锚点 publishedAt ?? fetchedAt 时间倒序，最新在前。
//
// 这是顺序契约的唯一实现点，两个写盘分支都过它。2026-09-15 站长裁定：顺序 = 时间倒序。
// 无锚点 / 锚点非法 → 视为最旧（排最后）；fetchedAt、id 依次兜底，保证重复运行字节一致。
function orderWindow(items) {
  return [...items].sort((a, b) => {
    const ta = anchorMs(a);
    const tb = anchorMs(b);
    if (tb !== ta) return tb - ta;
    const fa = a?.fetchedAt ?? '';
    const fb = b?.fetchedAt ?? '';
    if (fa !== fb) return fa < fb ? 1 : -1;
    const ia = a?.id ?? '';
    const ib = b?.id ?? '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// 写盘节流（规格 D35 与 D37 的交点，2026-09-15 修）。
//
// D35 要求「内容无变化时不产生 commit」，workflow 靠 `git diff --cached --quiet` 判定。
// 但顶层 `updated` 每次写盘都会变 —— 只要写盘，diff 就恒为非真，D35 的分支永远走不到。
// 此前每个成功分支都无条件写盘，于是这个契约实际是**死代码**。
// 实测证据（固定 RSS + 内存 store，同一份源数据跑两次、只有 now 不同）：
//   · 条目 id 集合完全相同   · 两次落盘字节不同   · 唯一差异 = `"updated"` 一行
//
// 现在：条目快照与上轮完全一致 → 不写盘（保留旧 updated，其语义变成「内容最后变化的时刻」）。
//
// ⚠️ 反向约束（D37）：规格 D37 记录「仓库连续 60 天无活动，GitHub 会停用定时任务」，
// 缓解手段正是「让任务自己产生提交来续期」。若源站长期停更导致内容一直不变，
// 节流会把续期机制一并掐掉。故保留兜底：距上次写盘超过 forceWriteAfterDays 时强制写一次。
//
// 注意节流的收益不是「少几个提交」——窗口每 12h 真的在换血（实测约 15 条换入换出），
// 正常情况每个定时点仍会写盘。收益是**恢复一个信号**：某轮跑出零 diff 现在意味着
// 「管线产出与上轮完全一致」，那是异常（源站挂了 / 解析退化了），值得被看见。
function shouldWrite(prevWindow, nextItems, now, config) {
  const prevItems = Array.isArray(prevWindow?.items) ? prevWindow.items : null;
  // 无上轮快照（冷启动）或字节有差异 → 必须写
  if (prevItems === null) return true;
  if (JSON.stringify(prevItems) !== JSON.stringify(nextItems)) return true;

  // 内容一致：只在「上次写盘已很久」时强制写一次，保 D37 续期
  const lastWrite = Date.parse(prevWindow?.updated ?? '');
  if (!Number.isFinite(lastWrite)) return true; // updated 缺失/非法 → 不敢节流
  const ageDays = (now.getTime() - lastWrite) / 86_400_000;
  return ageDays > config.forceWriteAfterDays;
}

export async function runPipeline({
  fetchImpl, // 必填：async (url, init) => { ok, status, text() }。测试注入假响应，绝不触网
  now = new Date(),
  config = CONFIG,
  store = realStore,
  rollover, // 可选 (input) => ({ window?, archives: [{month, items}] })（ticket 05 接线处）
} = {}) {
  const nowIso = now.toISOString();

  // 1) 逐源抓取 —— 每个源独立降级（见 lib/source.mjs），这里只负责汇总
  const results = await fetchAllSources({ fetchImpl, config });
  const okSources = results.filter((r) => r.ok);
  const sourceReport = describeSources(results);
  const fetched = results.reduce((n, r) => n + r.items.length, 0);

  // 2) 全源失败 → 静默跳过，不写文件（保留上次快照，规格 D18）。
  //    「部分失败」不算失败：拿到的源照常产出，坏源只体现在 sourceReport 里。
  if (okSources.length === 0) {
    return {
      status: 'skipped',
      reason: 'all_sources_unavailable',
      window: [],
      fetched: 0,
      kept: 0,
      sources: sourceReport,
    };
  }

  // 3) 逐源：过滤 → 排序 → 定额截断 → 塑形。
  //    每源定额（config.perSourceLimit，可按源覆盖）是**入选**规则，取代旧的「热度 × 时间衰减」：
  //    RSS 不带热度字段，且它的作用（把 30 个位置摊到整个窗口、不让单一高产源淹没别人）
  //    由「每源定额」更直接地实现 —— arXiv 单日 600+ 条，不定额会挤掉全部新闻源。
  const perSource = [];
  for (const r of okSources) {
    const source = config.sources.find((s) => s.id === r.id);
    const limit = Number.isFinite(source?.limit) ? source.limit : config.perSourceLimit;

    const kept = r.items
      .filter((raw) => {
        if (!raw.title || !raw.url) return false; // 无标题或无链接 = 不可用（schema §4）
        if (!matchesKeywords(`${raw.title} ${raw.summary}`, config.keywords)) return false;
        if (!withinWindow(
          { publishedAt: raw.publishedAt, fetchedAt: nowIso },
          now,
          config.windowHours,
          config.futureSlackHours,
        )) return false;
        return true;
      })
      .sort((a, b) => anchorMs(a) - anchorMs(b)) // 源内按时间升序 → 末尾 slice 出最新的 N 条
      .slice(-limit)
      .map((raw) => shapeItem(raw, {
        fetchedAt: nowIso,
        sourceLabel: source?.label ?? r.label,
        lang: source?.lang ?? r.lang,
        config,
      }));

    perSource.push(...kept);
  }

  // 4) 复用上一轮窗口里的同一条目 —— 这一步不是优化，是「落盘字节稳定」的唯一实现：
  //
  //   · **落盘字节稳定**：shapeItem 每次都把 fetchedAt 写成「此刻」。若不复用，
  //     即使源数据一模一样，所有条目的 fetchedAt 也全都变 → JSON 每次都不同 →
  //     workflow 每天产生两次「只有时间戳在动」的提交，D35「内容无变化时不产生 commit」失效。
  //
  // 代价（有意为之）：复用是整条记录沿用，因此窗口是一份「冻结快照」——
  // 一条新闻在它留在窗口期间不会被反复改写。对档案馆语义（快照优先于实时）是自洽的。
  const prevWindow = await store.readWindow();
  const prevById = new Map(
    (Array.isArray(prevWindow?.items) ? prevWindow.items : [])
      .filter((it) => it && typeof it.id === 'string')
      .map((it) => [it.id, it]),
  );
  const items = perSource.map((it) => prevById.get(it.id) ?? it);

  // 5) 去重：按 id（= 规范化 URL 短哈希）。同一篇文章被多个源转载、或带追踪参数的变体会塌缩成一条。
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    deduped.push(it);
  }

  // 6) 合并后按时间倒序取前 windowLimit 条（顺序此时即最终呈现顺序，见 orderWindow 注释）
  const window = orderWindow(deduped).slice(0, config.windowLimit);

  // 7) 失败语义（规格 D18）：低于阈值不写任何文件，返回 skipped，保留上次快照。
  if (window.length < config.minItems) {
    return {
      status: 'skipped',
      reason: `below_threshold:${window.length}<${config.minItems}`,
      window,
      fetched,
      kept: window.length,
      sources: sourceReport,
    };
  }

  // 8) 写出（rollover 接入点，ticket 05）。两个分支写盘前都过一遍 orderWindow()，
  //    也都要过一遍 shouldWrite()（规格 D35 + D37 的写盘节流，见函数注释）。
  //    节流判断必须在**将要落盘的那份数据**上做，所以放在分支内部、orderWindow 之后。
  if (rollover) {
    const result = await rollover({ window, now: nowIso, config });
    const rolledWindow = orderWindow(result?.window ?? window);
    const archives = result?.archives ?? [];

    if (!shouldWrite(prevWindow, rolledWindow, now, config)) {
      return {
        status: 'unchanged',
        window: rolledWindow,
        updated: prevWindow?.updated ?? null,
        fetched,
        kept: rolledWindow.length,
        sources: sourceReport,
      };
    }

    await store.writeWindow({ updated: nowIso, items: rolledWindow });
    for (const a of archives) {
      await store.writeArchive(a.month, { month: a.month, items: a.items });
    }
    return {
      status: 'written',
      window: rolledWindow,
      updated: nowIso,
      fetched,
      kept: rolledWindow.length,
      archives,
      sources: sourceReport,
    };
  }

  const orderedWindow = orderWindow(window);

  if (!shouldWrite(prevWindow, orderedWindow, now, config)) {
    return {
      status: 'unchanged',
      window: orderedWindow,
      updated: prevWindow?.updated ?? null,
      fetched,
      kept: orderedWindow.length,
      sources: sourceReport,
    };
  }

  await store.writeWindow({ updated: nowIso, items: orderedWindow });
  return {
    status: 'written',
    window: orderedWindow,
    updated: nowIso,
    fetched,
    kept: orderedWindow.length,
    sources: sourceReport,
  };
}
