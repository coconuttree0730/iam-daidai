// 归档按月滚动（ticket 05）纯逻辑回归锁。
// 运行：node qa/ai-news-archive.test.mjs
// 契约：只断言外部可观察行为（窗口长度、归档月份、无损去重、幂等、返回的变更桶），
// 不依赖内部实现；改内部实现应保持绿色，改外部契约应变红。
// 不触网、不启浏览器、不写真实仓库：注入内存假 store，条目自行按 schema §4 构造。
import assert from 'node:assert/strict';
import { createRollover, ARCHIVE_CONFIG } from '../scripts/ai-news/lib/archive.mjs';

const clone = (v) => structuredClone(v);

// 按 schema §4 构造 NewsItem（默认已翻译；可逐项覆盖）
let seq = 0;
function makeItem(over = {}) {
  seq += 1;
  const id = over.id ?? String(seq).padStart(12, '0').slice(-12);
  return {
    id,
    url: over.url ?? `https://example.com/${id}`,
    source: over.source ?? 'Hacker News',
    title: { en: over.titleEn ?? 'English title', zh: over.titleZh ?? '中文标题' },
    summary: { en: over.summaryEn ?? '', zh: over.summaryZh ?? '' },
    translated: over.translated ?? true,
    publishedAt: over.publishedAt ?? null,
    fetchedAt: over.fetchedAt ?? '2026-09-15T08:00:00.000Z',
    heat: over.heat ?? 10,
  };
}

// 内存假 store：由可变 disk 支撑；_apply 模拟 pipeline 在 rollover 返回后写盘的动作
function makeDisk(initial = {}) {
  const disk = { window: initial.window ?? [], archives: initial.archives ?? {} };
  const store = {
    async readWindow() {
      return { updated: null, items: disk.window.map(clone) };
    },
    async readArchive(month) {
      const items = disk.archives[month];
      return { month, items: items ? items.map(clone) : [] };
    },
  };
  store._apply = (result) => {
    disk.window = result.window.map(clone);
    for (const a of result.archives) disk.archives[a.month] = a.items.map(clone);
  };
  store._disk = disk;
  return store;
}

// 收集 disk 上「窗口 ∪ 全部归档」的 id 分布，用于无损 / 无重复 / 不相交断言
function collectIds(disk) {
  const locations = new Map(); // id -> ['window' | month, ...]
  for (const it of disk.window) {
    locations.set(it.id, [...(locations.get(it.id) ?? []), 'window']);
  }
  for (const [month, items] of Object.entries(disk.archives)) {
    for (const it of items) {
      locations.set(it.id, [...(locations.get(it.id) ?? []), month]);
    }
  }
  return locations;
}

function assertLosslessAndDisjoint(disk, expectedIds) {
  const loc = collectIds(disk);
  // 无损：期望的每一个 id 都出现，且不多不少
  const got = new Set(loc.keys());
  assert.equal(got.size, expectedIds.size, '历史条目总数应等于期望');
  for (const id of expectedIds) assert.ok(got.has(id), `条目 ${id} 不应丢失`);
  // 无重复：每个 id 在最终落盘状态里只出现一次（不跨两个桶）
  for (const [id, where] of loc) {
    assert.equal(where.length, 1, `条目 ${id} 不能同处多个桶：${where.join(',')}`);
  }
}

// ── 1) 历史充足时窗口恰为上限 ──
{
  const items = Array.from({ length: 40 }, (_, i) =>
    makeItem({ fetchedAt: `2026-09-15T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const store = makeDisk();
  const rollover = createRollover({ store });
  const res = await rollover({ window: items });
  assert.equal(res.window.length, ARCHIVE_CONFIG.windowLimit, '窗口长度应恰为 windowLimit');
}

// ── 2) 安静的一轮：用更早的（上一轮）条目向前补足，而非塌缩 ──
{
  const prevWindow = Array.from({ length: 30 }, (_, i) =>
    makeItem({ id: `prev${String(i).padStart(8, '0')}`, fetchedAt: `2026-09-14T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const fresh = Array.from({ length: 5 }, (_, i) =>
    makeItem({ id: `new${String(i).padStart(9, '0')}`, fetchedAt: `2026-09-15T09:00:0${i}.000Z` }),
  );
  const store = makeDisk({ window: prevWindow });
  const rollover = createRollover({ store });
  const res = await rollover({ window: fresh });
  assert.equal(res.window.length, ARCHIVE_CONFIG.windowLimit, '安静轮窗口仍应补足到上限');
  const winIds = new Set(res.window.map((i) => i.id));
  let retainedFromPrev = 0;
  for (const p of prevWindow) if (winIds.has(p.id)) retainedFromPrev += 1;
  assert.ok(retainedFromPrev > 0, '窗口应保留上一轮的更早条目（向前补足）');
}

// ── 3) 溢出按锚点月份入归档；publishedAt 为 null 回退 fetchedAt；publishedAt 跨月时锚点胜出 ──
{
  const keep = Array.from({ length: 30 }, (_, i) =>
    makeItem({ id: `k${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-15T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const itemPub = makeItem({ id: 'ovfPub', publishedAt: '2026-09-10T06:00:00.000Z', fetchedAt: '2026-09-15T08:30:00.000Z' }); // 锚点 09
  const itemNull = makeItem({ id: 'ovfNull', publishedAt: null, fetchedAt: '2026-08-20T06:00:00.000Z' }); // 回退 08
  const itemCross = makeItem({ id: 'ovfCross', publishedAt: '2026-07-05T06:00:00.000Z', fetchedAt: '2026-09-15T08:40:00.000Z' }); // 锚点 07 胜出（非 09）
  const itemPub2 = makeItem({ id: 'ovfPub2', publishedAt: '2026-09-12T06:00:00.000Z', fetchedAt: '2026-09-15T08:50:00.000Z' }); // 锚点 09
  const itemOld = makeItem({ id: 'ovfOld', publishedAt: null, fetchedAt: '2026-06-01T06:00:00.000Z' }); // 回退 06
  const input = [...keep, itemPub, itemNull, itemCross, itemPub2, itemOld];
  const store = makeDisk();
  const rollover = createRollover({ store });
  const res = await rollover({ window: input });
  assert.equal(res.window.length, 30, '窗口应恰为 30（5 条溢出）');

  const byMonth = new Map(res.archives.map((a) => [a.month, a.items]));
  assert.deepEqual([...byMonth.keys()].sort(), ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.ok(byMonth.get('2026-09').some((i) => i.id === 'ovfPub'), 'publishedAt 条目应入 2026-09');
  assert.ok(byMonth.get('2026-08').some((i) => i.id === 'ovfNull'), 'publishedAt=null 应回退 fetchedAt 入 2026-08');
  assert.ok(byMonth.get('2026-07').some((i) => i.id === 'ovfCross'), 'publishedAt 跨月应取其月份而非 fetchedAt');
  assert.ok(byMonth.get('2026-06').some((i) => i.id === 'ovfOld'), 'null publishedAt 旧 fetchedAt 应入 2026-06');
}

// ── 4) 窗口 ∪ 归档 无损且无重复（按 id）；无任何条目同处两桶 ──
{
  const all = Array.from({ length: 50 }, (_, i) =>
    makeItem({ id: `all${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-${String(15 - (i % 10)).padStart(2, '0')}T08:00:${String(i % 60).padStart(2, '0')}.000Z` }),
  );
  const store = makeDisk();
  const rollover = createRollover({ store });
  const res = await rollover({ window: all });
  store._apply(res);
  assertLosslessAndDisjoint(store._disk, new Set(all.map((i) => i.id)));
  // 窗口恰为上限
  assert.equal(store._disk.window.length, ARCHIVE_CONFIG.windowLimit);
}

// ── 5) 幂等：相同输入第二次运行 → 零变更桶、窗口不变 ──
{
  const all = Array.from({ length: 50 }, (_, i) =>
    makeItem({ id: `idem${String(i).padStart(9, '0')}`, publishedAt: null, fetchedAt: `2026-09-${String(15 - (i % 10)).padStart(2, '0')}T08:00:${String(i % 60).padStart(2, '0')}.000Z` }),
  );
  const store = makeDisk();
  const rollover = createRollover({ store });
  const r1 = await rollover({ window: all });
  store._apply(r1);
  const diskAfterFirst = clone(store._disk);

  const r2 = await rollover({ window: all });
  assert.equal(r2.archives.length, 0, '幂等：第二次运行不应报告任何变更桶');
  const win1 = new Set(r1.window.map((i) => i.id));
  const win2 = new Set(r2.window.map((i) => i.id));
  assert.deepEqual([...win2].sort(), [...win1].sort(), '幂等：窗口应保持不变');
  // 落盘状态也确实没变
  assert.deepEqual(clone(store._disk), diskAfterFirst, '幂等：应用后落盘状态应不变');
}

// ── 6) 顺序无关：既有归档 + 既有窗口，结果仍正确（无损 / 不相交） ──
{
  const prevWindow = Array.from({ length: 10 }, (_, i) =>
    makeItem({ id: `pw${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-15T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const archAug = Array.from({ length: 5 }, (_, i) =>
    makeItem({ id: `a8${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-08-20T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const archJul = Array.from({ length: 5 }, (_, i) =>
    makeItem({ id: `a7${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-07-20T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const fresh = Array.from({ length: 8 }, (_, i) =>
    makeItem({ id: `fr${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-16T09:00:0${i}.000Z` }),
  );
  const store = makeDisk({ window: prevWindow, archives: { '2026-08': archAug, '2026-07': archJul } });
  const rollover = createRollover({ store });
  const res = await rollover({ window: fresh });
  store._apply(res);

  const expected = new Set([...prevWindow, ...archAug, ...archJul, ...fresh].map((i) => i.id));
  assertLosslessAndDisjoint(store._disk, expected);
  // 既有归档月未被无关改动触碰（不在变更桶里）
  const changedMonths = new Set(res.archives.map((a) => a.month));
  assert.ok(!changedMonths.has('2026-08') && !changedMonths.has('2026-07'), '既有归档月若无相交改动不应被报告');
}

// ── 7) 归档条目保留中文翻译字段与 translated 标志（D14） ──
{
  const keep = Array.from({ length: 30 }, (_, i) =>
    makeItem({ id: `k7${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-15T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const zhItem = makeItem({ id: 'zh1', titleEn: 'AI news', titleZh: '人工智能新闻', summaryZh: '摘要', translated: true, publishedAt: null, fetchedAt: '2026-08-25T06:00:00.000Z' });
  const untrans = makeItem({ id: 'ut1', titleEn: 'Same', titleZh: 'Same', summaryEn: '', summaryZh: '', translated: false, publishedAt: null, fetchedAt: '2026-06-30T06:00:00.000Z' });
  const store = makeDisk();
  const rollover = createRollover({ store });
  const res = await rollover({ window: [...keep, zhItem, untrans] });
  const byMonth = new Map(res.archives.map((a) => [a.month, a.items]));
  const zh = byMonth.get('2026-08').find((i) => i.id === 'zh1');
  assert.equal(zh.title.zh, '人工智能新闻', '归档应保留 title.zh');
  assert.equal(zh.summary.zh, '摘要', '归档应保留 summary.zh');
  assert.equal(zh.translated, true, '归档应保留 translated=true');
  const ut = byMonth.get('2026-06').find((i) => i.id === 'ut1');
  assert.equal(ut.translated, false, '未翻译条目的 translated=false 不应被改写');
  assert.equal(ut.title.zh, 'Same', '未翻译时 title.zh 应等于 title.en（非空串）');
}

// ── 8) 仅回传变更桶；空输入 / 不变时 archives 为空 ──
{
  // 空输入、空 store → 不抛、archives 为空
  const store = makeDisk();
  const rollover = createRollover({ store });
  const empty = await rollover({ window: [] });
  assert.equal(empty.window.length, 0);
  assert.equal(empty.archives.length, 0, '空输入不应产生任何归档桶');

  // 不变场景：落盘后再用相同输入跑一次，archives 为空（已由 #5 覆盖，这里再确认接口语义）
  const items = Array.from({ length: 35 }, (_, i) =>
    makeItem({ id: `c${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-${String(15 - (i % 5)).padStart(2, '0')}T08:00:${String(i % 60).padStart(2, '0')}.000Z` }),
  );
  const s2 = makeDisk();
  const r2 = createRollover({ store: s2 });
  const first = await r2({ window: items });
  s2._apply(first);
  const second = await r2({ window: items });
  assert.equal(second.archives.length, 0, '无变化时应只回传空 archives');
}

// ── 9) 锚点不可解析：不崩溃、不从窗口丢弃、并显式暴露 id ──
{
  const keep = Array.from({ length: 30 }, (_, i) =>
    makeItem({ id: `bk${String(i).padStart(10, '0')}`, publishedAt: null, fetchedAt: `2026-09-15T08:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const bad = makeItem({ id: 'bad1', publishedAt: 'not-a-date', fetchedAt: 'also-bad' });
  const store = makeDisk();
  const rollover = createRollover({ store });
  const res = await rollover({ window: [...keep, bad] });
  assert.ok(res.unanchored.includes('bad1'), '锚点不可解析的 id 应在 unanchored 中暴露');
  assert.ok(res.window.some((i) => i.id === 'bad1'), '锚点不可解析的条目不应从窗口被丢弃');
  assert.ok(!res.archives.some((a) => a.items.some((i) => i.id === 'bad1')), '锚点不可解析的条目不应进入任何归档桶');
  const winIds = new Set(res.window.map((i) => i.id));
  assert.equal(winIds.size, res.window.length, '窗口内仍应无重复');
}

console.log('qa/ai-news-archive.test.mjs: all assertions passed');
