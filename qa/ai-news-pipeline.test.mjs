// RSS 抓取管线回归锁（取代旧的 HN Algolia 版本）。
// 运行：node qa/ai-news-pipeline.test.mjs
//
// 契约：只断言外部可观察行为（解析结果、每源定额、降级语义、输出顺序、字节稳定、去重、
// 关键词过滤），不依赖内部实现。不触网、不写真实仓库：注入假 fetch 与内存假 store。
//
// ⚠️ 2026-09-15 换源：数据源从 HN Algolia 改为「内容方自营 RSS 白名单」，
// 本文件相应重写。旧断言（时间切片铺满窗口、超限劈半递归、score 降序）已随实现一并移除；
// 新增断言的重点是**降级语义**（单源失败不影响其他源 / 全源失败不写盘），
// 因为换源后稳定性主要就靠这一层。
import assert from 'node:assert/strict';
import { parseFeed, cleanText, decodeEntities, pickLink, toIso } from '../scripts/ai-news/lib/rss.mjs';
import { fetchAllSources, describeSources } from '../scripts/ai-news/lib/source.mjs';
import { matchesKeywords, withinWindow, anchorMs } from '../scripts/ai-news/lib/text.mjs';
import { truncateSummary } from '../scripts/ai-news/lib/shape.mjs';
import { runPipeline } from '../scripts/ai-news/pipeline.mjs';
import { CONFIG } from '../scripts/ai-news/config.mjs';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-15T12:00:00.000Z');

// ── 测试用配置：源清单换成受控的假源，其余参数沿用生产值 ──────────────
// minItems 默认降到 1：多数用例只摆 1~3 条 fixture，真实的「低于阈值不写盘」语义
// 由第 14 项单独显式断言（那里传 minItems: 5），不必让每条用例都背这个门槛。
const T = (sources, over = {}) => ({ ...CONFIG, sources, minItems: 1, ...over });

const SOURCE_A = { id: 'a', label: '源A', lang: 'zh', url: 'https://a.test/feed' };
const SOURCE_B = { id: 'b', label: '源B', lang: 'zh', url: 'https://b.test/feed' };
const SOURCE_EN = { id: 'en', label: '源EN', lang: 'en', url: 'https://en.test/feed' };

// ── fixture 构造 ─────────────────────────────────────────────────────
function pubDate(hoursAgo) {
  return new Date(NOW.getTime() - hoursAgo * HOUR).toUTCString();
}

function rssItem({ title, url, hoursAgo = 1, desc = '' }) {
  return [
    '<item>',
    `<title>${title}</title>`,
    `<description><![CDATA[${desc}]]></description>`,
    `<link>${url}</link>`,
    `<pubDate>${pubDate(hoursAgo)}</pubDate>`,
    '<guid isPermaLink="false">g</guid>',
    '</item>',
  ].join('');
}

function rssFeed(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.join('')}</channel></rss>`;
}

// 假 fetch：url → { ok, status, text() }
function makeFetch(map) {
  return async (url) => {
    const v = map[url];
    if (v == null) return { ok: false, status: 404, async text() { return ''; } };
    if (v === 'throw') throw new Error('connection reset');
    return { ok: true, status: 200, async text() { return v; } };
  };
}

function makeStore(prev = { updated: null, items: [] }) {
  return {
    writes: 0,
    archiveWrites: 0,
    written: null,
    async readWindow() {
      return { updated: prev.updated, items: structuredClone(prev.items) };
    },
    async readArchive(month) {
      return { month, items: [] };
    },
    async writeWindow(payload) {
      this.writes += 1;
      this.written = structuredClone(payload);
    },
    async writeArchive() {
      this.archiveWrites += 1;
    },
  };
}

// ── 1) RSS 解析：基本字段 ────────────────────────────────────────────
{
  const xml = rssFeed([
    rssItem({ title: '大模型发布', url: 'https://x.test/a', hoursAgo: 2, desc: '这是一段导语' }),
  ]);
  const items = parseFeed(xml);
  assert.equal(items.length, 1, '应解析出 1 条');
  assert.equal(items[0].title, '大模型发布');
  assert.equal(items[0].url, 'https://x.test/a');
  assert.equal(items[0].summary, '这是一段导语');
  assert.equal(items[0].publishedAt, new Date(NOW.getTime() - 2 * HOUR).toISOString(), 'pubDate 应转成 ISO');
}

// ── 2) CDATA 与实体解码 ──────────────────────────────────────────────
{
  const xml = rssFeed([
    rssItem({ title: 'A &amp; B &#39;引号&#39;', url: 'https://x.test/b', desc: '<b>粗体</b> 与 &lt;标签&gt;' }),
  ]);
  const items = parseFeed(xml);
  assert.equal(items[0].title, "A & B '引号'", '实体应被解码');
  assert.equal(items[0].summary, '粗体 与 <标签>', 'CDATA 内的 HTML 应去标签后再解实体');
  assert.equal(decodeEntities('&#x41;&#66;'), 'AB', '数字实体（十六进制/十进制）应支持');
  assert.equal(cleanText('  a\n\n  b  '), 'a b', '空白应折叠');
}

// ── 3) Atom：<link href> 自闭合 + <published> ────────────────────────
{
  const xml = [
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '<entry><title>Atom title</title>',
    '<link rel="self" href="https://x.test/self"/>',
    '<link rel="alternate" href="https://x.test/real"/>',
    '<updated>2026-09-15T10:00:00Z</updated>',
    '<summary>短摘要</summary>',
    '</entry></feed>',
  ].join('');
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://x.test/real', '应优先取 rel=alternate，而不是 rel=self');
  assert.equal(items[0].publishedAt, '2026-09-15T10:00:00.000Z');
  // rel 缺省也要取
  assert.equal(pickLink('<link href="https://x.test/plain"/>'), 'https://x.test/plain');
}

// ── 4) 摘要候选取「最短的非空值」────────────────────────────────────
{
  const xml = [
    '<item><title>t</title><link>https://x.test/c</link>',
    `<pubDate>${pubDate(1)}</pubDate>`,
    '<description>一句话导语</description>',
    '<content:encoded>这是一整篇很长的正文，长度远超导语，属于全文转载的范畴。</content:encoded>',
    '</item>',
  ].join('');
  const items = parseFeed(xml);
  assert.equal(items[0].summary, '一句话导语', '应取最短的非空候选，而不是 content:encoded 全文');
}

// ── 5) 非 feed 输入（HTML 页面）不抛错、返回空数组 ───────────────────
{
  assert.deepEqual(parseFeed('<html><body>不是 feed</body></html>'), []);
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed(null), []);
  assert.equal(toIso('not-a-date'), null);
  assert.equal(toIso('Tue, 15 Sep 2026 12:10:52 GMT'), '2026-09-15T12:10:52.000Z', 'RFC822 + GMT 应可解析');
  assert.equal(toIso('Tue, 15 Sep 2026 17:00:00 +0800'), '2026-09-15T09:00:00.000Z', '+0800 应换算到 UTC');
  assert.equal(toIso('Tue, 15 Sep 2026 00:00:00 -0400'), '2026-09-15T04:00:00.000Z', '-0400 应换算到 UTC');
}

// ── 6) source.strip 剥前缀（arXiv 的公告抬头）───────────────────────
{
  const xml = rssFeed([
    rssItem({ title: 'Paper', url: 'https://x.test/d', desc: 'arXiv:2609.1v1 Announce Type: new Abstract: 真正的摘要内容在此处。' }),
  ]);
  const stripped = parseFeed(xml, { strip: /^\s*arXiv:\S+\s*Announce Type:\s*\w+\s*Abstract:\s*/i });
  assert.equal(stripped[0].summary, '真正的摘要内容在此处。', '前缀应被剥掉');
  const raw = parseFeed(xml);
  assert.ok(raw[0].summary.startsWith('arXiv:'), '不传 strip 时保持原样');
}

// ── 7) 关键词：英文词边界 + 中文命中 ─────────────────────────────────
{
  assert.ok(matchesKeywords('OpenAI ships GPT', ['gpt']));
  assert.ok(!matchesKeywords('he said it again', ['ai']), '"said" 不应被 "ai" 误命中');
  assert.ok(!matchesKeywords('a chair', ['ai']), '"chair" 不应被 "ai" 误命中');
  assert.ok(matchesKeywords('AI is here', ['ai']), '独立的 AI 应命中');
  assert.ok(matchesKeywords('国产大模型又发新版本', ['大模型']), '中文关键词应命中');
  assert.ok(matchesKeywords('算力需求暴涨', ['算力']), '中文关键词在句首应命中');
  assert.ok(!matchesKeywords('荣耀发布新手机', CONFIG.keywords), '与 AI 无关的中文标题不应命中');
}

// ── 8) 时间窗：正常 / 超期 / 未来（含容差）──────────────────────────
{
  assert.ok(withinWindow({ publishedAt: new Date(NOW - 10 * HOUR).toISOString() }, NOW, 72, 0));
  assert.ok(!withinWindow({ publishedAt: new Date(NOW - 100 * HOUR).toISOString() }, NOW, 72, 0), '超过 72h 应出窗');
  assert.ok(!withinWindow({ publishedAt: null, fetchedAt: null }, NOW, 72, 0), '无锚点应出窗');
  const future = new Date(NOW.getTime() + 6 * HOUR).toISOString();
  assert.ok(!withinWindow({ publishedAt: future }, NOW, 72, 0), '严格模式下未来时间应出窗');
  assert.ok(withinWindow({ publishedAt: future }, NOW, 72, 26), '容差内未来时间应放行（源站时区错误）');
  assert.ok(!withinWindow({ publishedAt: new Date(NOW.getTime() + 40 * HOUR).toISOString() }, NOW, 72, 26), '超出容差应出窗');
}

// ── 9) 摘要截断与过短置空 ────────────────────────────────────────────
{
  assert.equal(truncateSummary('abcdef', 10), 'abcdef', '未超限应原样');
  assert.equal(truncateSummary('abcdefghij', 4), 'abcd', '超限应截断');
  assert.equal(truncateSummary('abcd   ', 4), 'abcd', '截断后应去尾部空白');
  assert.equal(truncateSummary(null, 10), '', 'null 应得空串');
}

// ── 10) 单源抓取降级：HTTP 失败 / 抛错 / 200 但解析出 0 条 ────────────
{
  const good = rssFeed([rssItem({ title: '大模型', url: 'https://a.test/1', desc: '导语导语导语导语导语导语' })]);
  const results = await fetchAllSources({
    fetchImpl: makeFetch({
      [SOURCE_A.url]: good,
      [SOURCE_B.url]: 'throw',
      [SOURCE_EN.url]: '<html>不是 feed</html>',
    }),
    config: T([SOURCE_A, SOURCE_B, SOURCE_EN]),
  });
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true, '正常源应成功');
  assert.equal(results[1].ok, false, '抛错源应标失败');
  assert.equal(results[1].error, 'connection reset');
  assert.equal(results[2].ok, false, 'HTTP 200 但解析出 0 条应标失败（对方改版/返回 HTML）');
  assert.equal(results[2].error, 'no_items_parsed');
  assert.match(describeSources(results), /1\/3 源成功/, '摘要应反映成功源数');
}

// ── 11) 管线：每源定额生效，且总量不超窗口上限 ───────────────────────
{
  const many = Array.from({ length: 20 }, (_, i) =>
    rssItem({ title: `大模型进展 ${i}`, url: `https://a.test/n${i}`, hoursAgo: i, desc: '这是一段足够长的导语内容用于通过长度阈值' }));
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: rssFeed(many) }),
    now: NOW,
    config: T([SOURCE_A], { perSourceLimit: 6 }),
    store,
  });
  assert.equal(res.status, 'written');
  assert.equal(res.fetched, 20, 'fetched 应为解析到的原始条数');
  assert.equal(res.kept, 6, '每源定额 6 应生效');
  assert.equal(store.writes, 1);
  assert.ok(res.window.every((it) => it.source === '源A'), '来源名应取源配置的 label');
}

// ── 12) 管线：单源失败不影响其他源（部分失败语义）────────────────────
{
  const a = rssFeed([
    rssItem({ title: '大模型 A1', url: 'https://a.test/a1', hoursAgo: 1, desc: '导语内容足够长以通过最小长度阈值' }),
    rssItem({ title: '大模型 A2', url: 'https://a.test/a2', hoursAgo: 2, desc: '导语内容足够长以通过最小长度阈值' }),
  ]);
  const b = rssFeed([
    rssItem({ title: '算力 B1', url: 'https://b.test/b1', hoursAgo: 3, desc: '导语内容足够长以通过最小长度阈值' }),
    rssItem({ title: '算力 B2', url: 'https://b.test/b2', hoursAgo: 4, desc: '导语内容足够长以通过最小长度阈值' }),
  ]);
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: a, [SOURCE_B.url]: b }),
    now: NOW,
    config: T([SOURCE_A, SOURCE_B, { ...SOURCE_EN, id: 'dead', url: 'https://dead.test/feed' }]),
    store,
  });
  assert.equal(res.status, 'written', '有两个源可用就不应整体跳过');
  assert.equal(res.kept, 4, '可用源应全部产出，坏源只损失它自己');
  assert.match(res.sources, /2\/3 源成功/);
  assert.match(res.sources, /dead=http_404/);
}

// ── 13) 管线：全源失败 → skipped 且**不写盘**（保留上次快照）────────
{
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({}),
    now: NOW,
    config: T([SOURCE_A, SOURCE_B]),
    store,
  });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'all_sources_unavailable');
  assert.equal(store.writes, 0, '全源失败绝不能写盘');
  assert.equal(res.kept, 0);
}

// ── 14) 管线：低于 minItems → skipped 且不写盘（规格 D18）────────────
{
  const few = rssFeed([rssItem({ title: '大模型', url: 'https://a.test/only', desc: '导语内容足够长以通过最小长度阈值' })]);
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: few }),
    now: NOW,
    config: T([SOURCE_A], { minItems: 5 }),
    store,
  });
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /below_threshold/);
  assert.equal(store.writes, 0, '低于阈值不应写盘');
}

// ── 15) 管线：输出顺序 = 锚点时间倒序（最新在前）─────────────────────
{
  const items = [5, 1, 30, 12, 0.5].map((h, i) =>
    rssItem({ title: `大模型 ${i}`, url: `https://a.test/o${i}`, hoursAgo: h, desc: '导语内容足够长以通过最小长度阈值' }));
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: rssFeed(items) }),
    now: NOW,
    config: T([SOURCE_A]),
    store,
  });
  const anchors = res.window.map((it) => anchorMs(it));
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i - 1] >= anchors[i], '窗口应严格按时间倒序（非增）');
  }
  // 与源内顺序无关：最旧的那条必须排最后
  assert.match(res.window[res.window.length - 1].url, /\/o2$/, '30h 前那条应排最后');
}

// ── 16) 管线：跨源去重（同 URL 不同追踪参数）────────────────────────
{
  const a = rssFeed([rssItem({ title: '大模型同文', url: 'https://x.test/same?utm_source=a', hoursAgo: 1, desc: '导语内容足够长以通过最小长度阈值' })]);
  const b = rssFeed([rssItem({ title: '大模型同文', url: 'https://x.test/same/?utm_source=b#frag', hoursAgo: 2, desc: '导语内容足够长以通过最小长度阈值' })]);
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: a, [SOURCE_B.url]: b }),
    now: NOW,
    config: T([SOURCE_A, SOURCE_B]),
    store,
  });
  assert.equal(res.kept, 1, '规范化后同 URL 应塌缩为一条');
}

// ── 17) 管线：关键词过滤与时间窗过滤 ─────────────────────────────────
{
  const items = [
    rssItem({ title: '荣耀发布新手机', url: 'https://a.test/f1', hoursAgo: 1, desc: '普通消费电子产品的发布描述文本，与本次筛选目标无关' }),
    rssItem({ title: '大模型新版本发布', url: 'https://a.test/f2', hoursAgo: 2, desc: '导语内容足够长以通过最小长度阈值' }),
    rssItem({ title: '大模型旧闻', url: 'https://a.test/f3', hoursAgo: 100, desc: '导语内容足够长以通过最小长度阈值' }),
    rssItem({ title: '', url: 'https://a.test/f4', hoursAgo: 3, desc: '无标题应被丢弃' }),
  ];
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: rssFeed(items) }),
    now: NOW,
    config: T([SOURCE_A]),
    store,
  });
  assert.equal(res.kept, 1, '只应留下「大模型新版本发布」这一条');
  assert.equal(res.window[0].url, 'https://a.test/f2');
}

// ── 18) 管线：字节稳定 —— 同一份源数据二次运行**根本不写盘**────────────
// 2026-09-15 修正：旧断言是「二次运行写出的 items 字节一致、但 updated 前进」。
// 那正是 D35 失效的原因：只要写盘，顶层 updated 就变，workflow 的 git diff 恒为真。
// 现在的契约更强也更直白 —— 内容没变就不写盘，所以落盘字节**必然**不变。
{
  const xml = rssFeed([1, 2, 3].map((h, i) =>
    rssItem({ title: `大模型 ${i}`, url: `https://a.test/s${i}`, hoursAgo: h, desc: '导语内容足够长以通过最小长度阈值' })));

  const first = await (async () => {
    const store = makeStore();
    await runPipeline({ fetchImpl: makeFetch({ [SOURCE_A.url]: xml }), now: NOW, config: T([SOURCE_A]), store });
    return store.written;
  })();

  // 第二轮：store 里已有上一轮窗口，且 now 前进 1 小时（fetchedAt 会变）
  const later = new Date(NOW.getTime() + HOUR);
  const store2 = makeStore({ updated: first.updated, items: first.items });
  const res2 = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: xml }),
    now: later,
    config: T([SOURCE_A]),
    store: store2,
  });

  assert.equal(res2.status, 'unchanged', '同源数据二次运行必须报 unchanged');
  assert.equal(store2.writes, 0, '不写盘 —— 这是「落盘字节必然不变」的更强形式');
  assert.equal(store2.written, null);
  assert.deepEqual(res2.window, first.items,
    '本轮算出的窗口必须与上轮落盘逐字节一致（证明「不写」不是因为内容被悄悄改了）');
  assert.equal(res2.updated, first.updated, 'updated 保留上轮值：它的语义是「内容最后变化的时刻」');
}

// ── 19) 管线：摘要截断在落盘前生效（安全边界）────────────────────────
{
  const longDesc = '这是一段非常长的正文'.repeat(60); // 600 字符
  const xml = rssFeed([rssItem({ title: '大模型', url: 'https://a.test/long', hoursAgo: 1, desc: longDesc })]);
  const store = makeStore();
  const res = await runPipeline({ fetchImpl: makeFetch({ [SOURCE_A.url]: xml }), now: NOW, config: T([SOURCE_A]), store });
  assert.equal(res.window[0].summary.zh.length, CONFIG.summaryMaxChars, '摘要必须截断到上限');
  assert.ok(!res.window[0].summary.zh.endsWith(' '), '截断后不应留尾部空白');
  assert.equal(res.window[0].summary.en, res.window[0].summary.zh, '未翻译时中英同值（D7 不产生空字段）');
}

// ── 20) 管线：过短摘要置空 ───────────────────────────────────────────
{
  const xml = rssFeed([rssItem({ title: '大模型', url: 'https://a.test/short', hoursAgo: 1, desc: '点击查看原文>' })]);
  const store = makeStore();
  const res = await runPipeline({ fetchImpl: makeFetch({ [SOURCE_A.url]: xml }), now: NOW, config: T([SOURCE_A]), store });
  assert.equal(res.window[0].summary.zh, '', '短于阈值的导流语应置空');
}

// ── 21) 管线：lang 透传（页面据此判断是否打「未翻译」标）─────────────
{
  const zh = rssFeed([rssItem({ title: '大模型', url: 'https://a.test/zh', hoursAgo: 1, desc: '导语内容足够长以通过最小长度阈值' })]);
  const en = rssFeed([rssItem({ title: 'LLM paper', url: 'https://en.test/en', hoursAgo: 2, desc: 'This is a sufficiently long abstract for the test.' })]);
  const store = makeStore();
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: zh, [SOURCE_EN.url]: en }),
    now: NOW,
    config: T([SOURCE_A, SOURCE_EN]),
    store,
  });
  const byId = new Map(res.window.map((it) => [it.url, it]));
  assert.equal(byId.get('https://a.test/zh').lang, 'zh');
  assert.equal(byId.get('https://en.test/en').lang, 'en');
  assert.ok(res.window.every((it) => it.translated === false), '默认不翻译');
}

// ── 22) 管线：rollover 分支同样写盘、同样按时间倒序 ──────────────────
{
  const xml = rssFeed([1, 2, 3].map((h, i) =>
    rssItem({ title: `大模型 ${i}`, url: `https://a.test/r${i}`, hoursAgo: h, desc: '导语内容足够长以通过最小长度阈值' })));
  const store = makeStore();
  let rolloverCalled = 0;
  const res = await runPipeline({
    fetchImpl: makeFetch({ [SOURCE_A.url]: xml }),
    now: NOW,
    config: T([SOURCE_A]),
    store,
    rollover: async ({ window }) => {
      rolloverCalled += 1;
      // 故意打乱顺序，验证写盘顺序由 pipeline 的 orderWindow 兜底
      return { window: [...window].reverse(), archives: [{ month: '2026-09', items: [] }] };
    },
  });
  assert.equal(rolloverCalled, 1);
  assert.equal(res.status, 'written');
  assert.equal(store.writes, 1);
  assert.equal(store.archiveWrites, 1, 'rollover 报告的归档桶应被写出');
  const anchors = store.written.items.map((it) => anchorMs(it));
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i - 1] >= anchors[i], 'rollover 打乱顺序后仍应被 orderWindow 修正为时间倒序');
  }
}

// ── 23) 管线：内容与上轮完全一致 → unchanged 且**不写盘**（规格 D35）──
// workflow 的「无 diff 就跳过提交」全靠这条成立：只要还写盘，顶层 updated 就会变，
// git diff 恒为非真，D35 就成了死代码（2026-09-15 实测踩到的正是这一点）。
{
  const xml = rssFeed([1, 2, 3].map((h, i) =>
    rssItem({ title: `大模型 ${i}`, url: `https://a.test/u${i}`, hoursAgo: h, desc: '导语内容足够长以通过最小长度阈值' })));
  const config = T([SOURCE_A]);
  const fetchImpl = makeFetch({ [SOURCE_A.url]: xml });

  // 第一轮：空 store → 正常写盘，拿到真实落盘载荷当作「上轮快照」
  const first = makeStore();
  const r1 = await runPipeline({ fetchImpl, now: NOW, config, store: first });
  assert.equal(r1.status, 'written');
  assert.equal(first.writes, 1);

  // 第二轮：源数据与 now 都不变
  const second = makeStore({ updated: first.written.updated, items: first.written.items });
  const r2 = await runPipeline({ fetchImpl, now: NOW, config, store: second });
  assert.equal(r2.status, 'unchanged', '内容一致必须报 unchanged');
  assert.equal(second.writes, 0, 'unchanged 时绝不能写盘——这正是 workflow 跳过提交的依据');
  assert.equal(second.archiveWrites, 0, 'unchanged 时也不应写归档');
  assert.equal(r2.updated, first.written.updated, 'updated 必须保留旧值，不能推进');
  assert.deepEqual(r2.window.map((it) => it.id), r1.window.map((it) => it.id));
}

// ── 24) 管线：内容一致但距上次写盘超过 forceWriteAfterDays → 强制写（规格 D37）──
// D37 靠「任务自己产生提交」防止仓库 60 天无活动被停用定时任务；
// 节流若把这条兜底也掐掉，长期停更的源会让整个定时任务悄悄死掉。
{
  const xml = rssFeed([1, 2, 3].map((h, i) =>
    rssItem({ title: `大模型 ${i}`, url: `https://a.test/u${i}`, hoursAgo: h, desc: '导语内容足够长以通过最小长度阈值' })));
  const config = T([SOURCE_A]);
  const fetchImpl = makeFetch({ [SOURCE_A.url]: xml });

  const first = makeStore();
  await runPipeline({ fetchImpl, now: NOW, config, store: first });
  const stale = new Date(NOW.getTime() - (CONFIG.forceWriteAfterDays + 5) * 24 * HOUR).toISOString();

  const store = makeStore({ updated: stale, items: first.written.items });
  const res = await runPipeline({ fetchImpl, now: NOW, config, store });
  assert.equal(res.status, 'written', '超过强制写盘期限必须打破节流');
  assert.equal(store.writes, 1);
  assert.ok(Date.parse(res.updated) > Date.parse(stale), 'updated 应推进到本轮时刻');
}

// ── 25) 管线：上轮快照与本轮不同 → 照常写盘（节流不能误伤正常更新）────
{
  const xml = rssFeed([1, 2, 3].map((h, i) =>
    rssItem({ title: `大模型 ${i}`, url: `https://a.test/u${i}`, hoursAgo: h, desc: '导语内容足够长以通过最小长度阈值' })));
  const config = T([SOURCE_A]);
  const fetchImpl = makeFetch({ [SOURCE_A.url]: xml });

  const first = makeStore();
  await runPipeline({ fetchImpl, now: NOW, config, store: first });

  // 上轮只有 2 条、updated 是本轮同一时刻：既没过期，内容也确实变了
  const store = makeStore({ updated: NOW.toISOString(), items: first.written.items.slice(0, 2) });
  const res = await runPipeline({ fetchImpl, now: NOW, config, store });
  assert.equal(res.status, 'written', '条目有增减就必须写盘');
  assert.equal(store.writes, 1);
  assert.equal(res.window.length, 3);
}

console.log('qa/ai-news-pipeline.test.mjs: all assertions passed');
