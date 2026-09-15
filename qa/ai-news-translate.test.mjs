// ticket 04 GLM 翻译接入 —— 纯逻辑回归（无框架、无网络、无浏览器）。
// 运行：node qa/ai-news-translate.test.mjs
// 契约：只断言外部可观察行为（导出函数 + 注入的 fetchImpl 调用计数），便于内部重构保持绿、改契约变红。
import assert from 'node:assert/strict';
import { createEnricher, TRANSLATE_CONFIG } from '../scripts/ai-news/lib/translate.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

// 构造 n 条未翻译条目；en 标题含可识别序号，便于对齐断言。
function makeItems(n, { translated = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    url: `https://example.com/${i}`,
    source: 'Hacker News',
    title: { en: `EN title ${i}`, zh: `EN title ${i}` },
    summary: { en: `EN summary ${i}`, zh: `EN summary ${i}` },
    translated,
    publishedAt: null,
    fetchedAt: '2026-09-15T00:00:00.000Z',
    heat: 1,
  }));
}

// 好响应：内容是与批次等长、标题标号为 ZH0.. 的译文数组（证明索引对齐）。
function goodFetch() {
  let calls = 0;
  return {
    calls: () => calls,
    bodies: [],
    impl: async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      const n = (body.messages[1].content.match(/^\s*\d+\.\s/gm) || []).length;
      const arr = Array.from({ length: n }, (_, i) => ({
        title: `ZH${i}`,
        summary: `ZS${i}`,
      }));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] }),
      };
    },
  };
}

// 顺序响应：按 call 序号返回不同响应（用于 429/401/畸形 等场景）。
function seqFetch(responders) {
  let calls = 0;
  const bodies = [];
  return {
    calls: () => calls,
    bodies,
    impl: async (url, init) => {
      calls++;
      bodies.push(init);
      const r = responders[calls - 1] ?? responders[responders.length - 1];
      return r(init);
    },
  };
}

const ok200 = (init) => ({
  ok: true,
  status: 200,
  text: async () => {
    const body = JSON.parse(init.body);
    const n = (body.messages[1].content.match(/^\s*\d+\.\s/gm) || []).length;
    const arr = Array.from({ length: n }, (_, i) => ({
      title: `ZH${i}`,
      summary: `ZS${i}`,
    }));
    return JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] });
  },
});

// ── 1) 批内 N 条 → N 条译文，索引严格对齐 ────────────────────────────────────
{
  const N = 6;
  const fetch = goodFetch();
  const enrich = createEnricher({ fetchImpl: fetch.impl, apiKey: 'k' });
  const out = await enrich(makeItems(N), { now: new Date(), config: {} });
  assert.equal(out.length, N);
  for (let i = 0; i < N; i++) {
    // 关键对齐断言：第 i 条译文必须落到第 i 条。把译文「右移一位」的错误实现会在此失败。
    assert.equal(out[i].title.zh, `ZH${i}`);
    assert.equal(out[i].summary.zh, `ZS${i}`);
    assert.equal(out[i].translated, true);
  }
  assert.equal(fetch.calls(), 1); // 批量：一请求多条
}

// ── 2) 429 后成功 → 确实重试，且条目最终被翻译 ──────────────────────────────
{
  const fetch = seqFetch([
    () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
    ok200,
  ]);
  const enrich = createEnricher({
    fetchImpl: fetch.impl,
    apiKey: 'k',
    config: { ...TRANSLATE_CONFIG, retryBaseMs: 1 },
  });
  const out = await enrich(makeItems(3), { now: new Date(), config: {} });
  assert.equal(fetch.calls(), 2, '应重试一次（共 2 次尝试）');
  assert.equal(out[0].translated, true);
  assert.equal(out[0].title.zh, 'ZH0');
}

// ── 3) 401 → 仅 1 次尝试，且以可区分错误失败 ────────────────────────────────
{
  const fetch = seqFetch([() => ({ ok: false, status: 401, text: async () => 'unauthorized' })]);
  const enrich = createEnricher({
    fetchImpl: fetch.impl,
    apiKey: 'k',
    config: { ...TRANSLATE_CONFIG, retryBaseMs: 1 },
  });
  await assert.rejects(
    enrich(makeItems(3), { now: new Date(), config: {} }),
    (err) => err && err.name === 'TranslationAuthError' && err.code === 'AUTH_FAILED',
    '401 必须抛出可区分错误且不重试',
  );
  assert.equal(fetch.calls(), 1, '401 不重试，仅 1 次请求');
}

// ── 4) 畸形响应 → 该批降级，另一批保留翻译（单批隔离）────────────────────────
{
  // 用较小 batchSize 制造两批；前 2 次调用返回畸形（截断 JSON 的 200 响应），第 3 次返回好响应。
  // 注意：必须是函数，seqFetch 会按 r(init) 调用；返回 200 + 截断 body 才能走「畸形响应」分支而非网络错误分支。
  const malformed = () => ({
    ok: true,
    status: 200,
    text: async () => '[{"title":"译', // 截断，不可解析为数组
  });
  const fetch = seqFetch([malformed, malformed, ok200]);
  const enrich = createEnricher({
    fetchImpl: fetch.impl,
    apiKey: 'k',
    config: { ...TRANSLATE_CONFIG, batchSize: 2, retryBaseMs: 1 },
  });
  const out = await enrich(makeItems(4), { now: new Date(), config: {} });
  // 第 1 批（条目 0,1）畸形 → 降级：zh === en, translated false
  assert.equal(out[0].translated, false);
  assert.equal(out[0].title.zh, out[0].title.en);
  assert.equal(out[1].translated, false);
  // 第 2 批（条目 2,3）成功翻译
  assert.equal(out[2].translated, true);
  assert.equal(out[2].title.zh, 'ZH0');
  assert.equal(out[3].translated, true);
  assert.equal(out[3].title.zh, 'ZH1');
}

// ── 5) 已翻译条目：完全跳过，不送模型、不改动 ────────────────────────────────
{
  const items = makeItems(3);
  items[0].translated = true;
  items[0].title.zh = '已是中文0';
  items[0].summary.zh = '已摘0';
  items[2].translated = true;
  items[2].title.zh = '已是中文2';

  const fetch = goodFetch();
  const enrich = createEnricher({ fetchImpl: fetch.impl, apiKey: 'k' });
  const out = await enrich(items, { now: new Date(), config: {} });

  // 只有 1 条未翻译 → 仅 1 个批次、1 次请求
  assert.equal(fetch.calls(), 1);
  // 已翻译条目原样保留
  assert.equal(out[0].title.zh, '已是中文0');
  assert.equal(out[0].summary.zh, '已摘0');
  assert.equal(out[0].translated, true);
  assert.equal(out[2].title.zh, '已是中文2');
  // 未翻译条目被翻译
  assert.equal(out[1].translated, true);
  // 已翻译条目的 en 标题绝不应出现在任何请求体中
  const joinedBodies = fetch.bodies.map((b) => b.body).join('|');
  assert.ok(!joinedBodies.includes('EN title 0'), '已翻译条目不应进请求体');
  assert.ok(!joinedBodies.includes('EN title 2'), '已翻译条目不应进请求体');
}

// 始终畸形的响应（截断 JSON，不可解析为数组）。函数形式：返回 200 + 截断 body。
const malformedAlways = () => ({
  ok: true,
  status: 200,
  text: async () => '[{"title":"译',
});

// ── 6) 降级绝不产生空 title.zh ──────────────────────────────────────────────
{
  const items = makeItems(2);
  items[0].title.en = 'Some English headline';
  items[1].title.en = 'Another headline';
  const fetch = seqFetch([malformedAlways]);
  const enrich = createEnricher({
    fetchImpl: fetch.impl,
    apiKey: 'k',
    config: { ...TRANSLATE_CONFIG, batchSize: 4, retryBaseMs: 1 },
  });
  const out = await enrich(items, { now: new Date(), config: {} });
  for (const it of out) {
    assert.equal(it.translated, false);
    assert.notEqual(it.title.zh, '', '降级时 title.zh 绝不为空');
    assert.equal(it.title.zh, it.title.en);
  }
}

// ── 7) 确定性：同输入两次 → 深相等 ──────────────────────────────────────────
{
  const enrich = createEnricher({ fetchImpl: goodFetch().impl, apiKey: 'k' });
  const a = await enrich(makeItems(5).map((x) => JSON.parse(JSON.stringify(x))), {
    now: new Date(),
    config: {},
  });
  const b = await enrich(makeItems(5).map((x) => JSON.parse(JSON.stringify(x))), {
    now: new Date(),
    config: {},
  });
  assert.deepEqual(a, b);
}

// ── 8) 每次请求都配置超时（AbortSignal）─────────────────────────────────────
{
  let capturedSignal = null;
  const fakeFetch = async (url, init) => {
    capturedSignal = init.signal;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ title: 'ZH0', summary: 'ZS0' }]) } }] }),
    };
  };
  const enrich = createEnricher({ fetchImpl: fakeFetch, apiKey: 'k' });
  await enrich(makeItems(1), { now: new Date(), config: {} });
  assert.ok(capturedSignal instanceof AbortSignal, '请求 init 必须带 AbortSignal 超时');
}

// ── 9) 密钥绝不进入日志 ─────────────────────────────────────────────────────
{
  const secret = 'GLM_SUPER_SECRET_KEY_12345';
  const seen = [];
  const spy = (level) => (...args) => seen.push(args.map(String).join(' '));
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = spy('log');
  console.error = spy('error');
  console.warn = spy('warn');
  try {
    const enrich = createEnricher({ fetchImpl: goodFetch().impl, apiKey: secret });
    await enrich(makeItems(2), { now: new Date(), config: {} });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
  const leaked = seen.some((line) => line.includes(secret));
  assert.equal(leaked, false, '日志中不应出现 API 密钥');
}

console.log('qa/ai-news-translate.test.mjs: all assertions passed');
