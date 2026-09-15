// 归档按月滚动（ticket 05 / LAB-NEWS）。
//
// 职责：把被「当前窗口」挤出的旧条目滚入按 YYYY-MM 切分的归档桶，使历史既不丢失
// 也不重复；归档条目与窗口条目完全同构（含中文翻译字段，schema §4 / D14）。
// 本模块只负责「存储策略」，时间线呈现（按年/月分组）是 ticket 06 的事。
//
// 设计要点
// --------
// 1) 滑动窗口（D11/D12）：最终窗口 = 全量历史（上一轮持久化的窗口 ∪ 本轮新条目，
//    按 id 去重）中锚点最新的 windowLimit 条。上一轮窗口本身已由 store 持久化，
//    所以「安静的一轮」不会让窗口塌缩到只剩当日几条——它用更早的窗口条目向前补足。
// 2) 锚点（schema §5）：anchor(item) = item.publishedAt ?? item.fetchedAt。
//    月份 = 锚点 UTC 的 'YYYY-MM'。publishedAt 可能为 null，必须回退 fetchedAt；
//    若 publishedAt 与 fetchedAt 落在不同月，以锚点（publishedAt）为准。
// 3) 锚点不可解析（无法归入任何月份）的条目：归档按月份切分，它无处可去，也绝不
//    从窗口丢弃——它永远钉在窗口里（窗口是它唯一安全的落脚处）。这类条目的 id
//    通过返回值的 `unanchored` 字段显式暴露，让「可能的丢失」可见而非静默吞掉。
// 4) 幂等：同一输入第二次运行，每个归档桶重算后与磁盘内容一致 → 不报告任何变更桶，
//    窗口也保持不变。
// 5) 最小写入：只回传「内容真正变化」的桶；未变化的桶原样留在磁盘，调用方据此
//    做最小数量写盘，避免每次运行都产生无意义的全量 diff。
// 6) 全量历史 = 窗口 ∪ 各归档桶，按 id 去重后两两不交、且无缺漏（D11 / D13）。
//
// 调用方契约（pipeline.mjs step 9）：rollover({ window, now, config }) 只读取
// store 的旧状态、返回 { window, archives, unanchored }；真正的写盘由 pipeline 在
// 本函数返回之后执行。因此本函数内部可安全读取上一轮窗口与既有归档。

export const ARCHIVE_CONFIG = {
  // 当前窗口恒定上限，必须与 config.mjs 的 windowLimit 一致（schema §2：当前窗口 ≤ 30）
  windowLimit: 30,
};

// anchor：publishedAt 优先，缺失 / null / undefined 时回退 fetchedAt（schema §5）
function anchorOf(item) {
  const a = item.publishedAt ?? item.fetchedAt;
  return a == null ? null : String(a);
}

// 由 ISO 字符串取 UTC 的 'YYYY-MM'；不可解析返回 null
function monthOf(iso) {
  if (iso == null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

// 排序用时间戳：无锚点 / 锚点非法 → -Infinity（排最后，但会被强制钉在窗口）
function anchorTime(item) {
  const a = anchorOf(item);
  if (a == null) return -Infinity;
  const d = new Date(a);
  return Number.isNaN(d.getTime()) ? -Infinity : d.getTime();
}

// 结构化深拷贝（仅用语言标准库；条目为纯 JSON 数据）
function clone(value) {
  return structuredClone(value);
}

// 规范化一个条目为可比较字符串（键排序，避免键序差异造成误判）
function canonItem(it) {
  return JSON.stringify(sortKeys(it));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

// 两个桶是否逐条相等（按 id 去重后集合相等且内容一致）
function bucketEqual(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map(canonItem));
  if (setA.size !== a.length) return false; // 桶内自身重复
  const setB = new Set(b.map(canonItem));
  if (setB.size !== b.length) return false;
  for (const x of setA) if (!setB.has(x)) return false;
  return true;
}

// 工厂：注入一个 store（真实 store 或测试用内存假 store），返回 rollover 函数。
// 工厂闭包持有 store，从而不改动 pipeline.mjs；config 默认取 ARCHIVE_CONFIG，
// 但运行期 pipeline 传入的 config（含 windowLimit）优先级更高。
export function createRollover({ store, config = ARCHIVE_CONFIG } = {}) {
  if (!store || typeof store.readWindow !== 'function' || typeof store.readArchive !== 'function') {
    throw new Error('createRollover: 需要一个提供 readWindow / readArchive 的 store');
  }

  // 返回：async ({ window, now, config }) => ({ window, archives, unanchored })
  return async function rollover({ window = [], now, config: runConfig } = {}) {
    const limit = runConfig?.windowLimit ?? config.windowLimit;

    // 1) 读取上一轮窗口（持久化的「更早条目」，用于补足与去重）
    let prevItems = [];
    try {
      const prev = await store.readWindow();
      prevItems = Array.isArray(prev?.items) ? prev.items : [];
    } catch {
      prevItems = [];
    }

    // 2) 合并全量历史（按 id 去重；同 id 以本轮新条目为准——它可能已被重新翻译）
    const byId = new Map();
    for (const it of prevItems) if (it && it.id != null) byId.set(it.id, it);
    for (const it of window) if (it && it.id != null) byId.set(it.id, it);
    const allItems = [...byId.values()];

    // 3) 排序：锚点倒序（无锚点视为最旧），fetchedAt 倒序，id 兜底——保证字节稳定。
    //    ⚠️ 这里排序的目的是**取数**：决定「哪 limit 条留在窗口」（最新者优先）。
    //    它不定义窗口的**输出顺序**——那是 pipeline 写盘前 orderWindow() 的职责
    //    （SCHEMA §3：窗口一律按锚点时间倒序呈现）。两者结果当前一致，但别把顺序契约
    //    挂在这一步上：将来若改动取数逻辑，顺序承诺不应被牵连。
    allItems.sort((a, b) => {
      const ta = anchorTime(a), tb = anchorTime(b);
      if (tb !== ta) return tb - ta;
      const fa = a.fetchedAt ?? '', fb = b.fetchedAt ?? '';
      if (fa !== fb) return fa < fb ? 1 : -1;
      const ia = a.id ?? '', ib = b.id ?? '';
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });

    // 4) 选出窗口 & 计算溢出（按锚点月份分桶）。
    //    无锚点条目永远钉在窗口（不丢失、不进归档），其 id 记入 unanchored。
    const unanchored = new Set();
    const pinned = []; // 无锚点条目（强制留窗口）
    const rest = []; // 可定位条目（按排序已倒序）
    for (const it of allItems) {
      if (monthOf(anchorOf(it)) == null) pinned.push(it);
      else rest.push(it);
    }
    const pinnedKept = pinned.slice(0, limit); // 极端情况下也最多占满窗口
    for (const it of pinnedKept) unanchored.add(it.id);

    const slotsForRest = Math.max(0, limit - pinnedKept.length);
    const windowItems = [...pinnedKept, ...rest.slice(0, slotsForRest)];
    const overflow = rest.slice(slotsForRest);

    const overflowByMonth = new Map();
    for (const it of overflow) {
      const m = monthOf(anchorOf(it)); // 此处锚点必可解析（已在 rest 中）
      if (!overflowByMonth.has(m)) overflowByMonth.set(m, []);
      overflowByMonth.get(m).push(it);
    }

    const windowIds = new Set(windowItems.map((i) => i.id));

    // 5) 对每个相关月份重算归档桶：
    //    - 该月既有条目中、此刻已进入窗口的 id 一律剔除（被重新顶上来的条目离开归档）
    //    - 再把本月的溢出条目合并进去（按 id 去重，逐条 verbatim 拷贝，保留中文翻译）
    //    仅当桶内容真正变化时，才计入返回结果（最小写入）。
    const relevantMonths = new Set();
    for (const it of allItems) {
      const m = monthOf(anchorOf(it));
      if (m != null) relevantMonths.add(m);
    }

    const archives = [];
    for (const month of relevantMonths) {
      let existingItems = [];
      try {
        const existing = await store.readArchive(month);
        existingItems = Array.isArray(existing?.items) ? existing.items : [];
      } catch {
        existingItems = [];
      }

      const kept = existingItems.filter((it) => !windowIds.has(it.id));
      const add = overflowByMonth.get(month) ?? [];
      const keptIds = new Set(kept.map((i) => i.id));
      const added = [];
      for (const it of add) {
        if (keptIds.has(it.id)) continue;
        if (added.some((x) => x.id === it.id)) continue;
        added.push(clone(it)); // verbatim：含 title.zh / summary.zh / translated
      }
      const newBucket = [...kept, ...added];

      if (!bucketEqual(newBucket, existingItems)) {
        archives.push({ month, items: newBucket });
      }
    }

    // 返回窗口（逐条引用原始数据，调用方写盘时会序列化；不在此处改动原始对象）
    return {
      window: windowItems,
      archives,
      // 显式暴露锚点不可解析的条目 id，让「可能的丢失」可见而非静默
      unanchored: [...unanchored],
    };
  };
}
