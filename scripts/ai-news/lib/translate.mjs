// 离线管线 enrich 钩子 —— ticket 04「GLM 翻译接入」。
//
// 职责：只把 translated === false 的新条目翻译成中文（标题 + 摘要），已翻译条目跳过且不改动。
// 服务不可用时，受影响批次降级为「中文 = 英文、translated:false」，其余批次照常翻译（单批隔离）。
//
// 纯度约束（来自票据硬规则，也是可测性的前提）：
//   - 绝不读 process.env；apiKey 只从注入参数取得。
//   - 绝不调用全局 fetch；网络只通过注入的 fetchImpl 发生。
//   - 绝不打印请求头 / 环境变量 / 完整错误对象；密钥永不进入日志。
//   - 只依赖 Node 标准库（setTimeout / AbortSignal 皆为全局），无新依赖。

export const TRANSLATE_CONFIG = {
  // Zhipu GLM OpenAI 兼容 chat/completions 端点（免费档，D19）。
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  // 免费档模型：glm-4-flash（D19）。非推理模型，单并发 ≈1 req/s。
  model: 'glm-4-flash',
  // 每请求打包条数：免费档单并发，必须批量顺序发送，绝不一请求一条（D20）。
  batchSize: 8,
  // 单次请求超时（通过 AbortSignal.timeout 配置）。
  timeoutMs: 30_000,
  // 指数退避基数（毫秒）：第 n 次重试延迟 = retryBaseMs × 2^(n-1)，与 ≈1 req/s 节奏匹配。
  retryBaseMs: 800,
  // 确定性：同输入同输出，保证「只在内容变化才提交」的幂等（D21 / D44）。
  temperature: 0,
  // thinking：glm-4-flash 不是推理模型，没有深度思考开关，故省略该字段。
  // 若以后换成 GLM-4.5/4.6 类推理模型，需在此加 thinking: { type: 'disabled' }，
  // 否则「推理」模型会成倍消耗免费档额度与时间，而翻译并不需要它。
};

// 返回 enrich 钩子：async (items, ctx) => items。pipeline.mjs 会传入 ctx = { now, config }，本模块忽略之。
export function createEnricher({ fetchImpl, apiKey, config = TRANSLATE_CONFIG }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('translate: fetchImpl (async (url, init) => res) is required');
  }
  return async function enrich(items, _ctx) {
    const list = Array.isArray(items) ? items : [];
    // 只翻译 translated !== true 的条目；已翻译条目跳过且不改动。
    const untranslated = list.filter((it) => !(it && it.translated === true));
    if (untranslated.length === 0) {
      return list.map(cloneItem); // 没有可翻的：原样返回副本（不改动调用方对象）
    }

    // 批量顺序发送（免费档单并发，绝不能并行）。
    const batches = chunk(untranslated, config.batchSize);
    const resultByItem = new Map();
    for (const batch of batches) {
      const tr = await translateBatch(batch, { fetchImpl, apiKey, config });
      batch.forEach((item, i) => {
        // tr 为对齐后的 [{title, summary}, ...]，或 null（该批降级）。
        resultByItem.set(item, tr ? tr[i] : null);
      });
    }

    // 按原始顺序拼回，已翻译条目原样保留。
    return list.map((it) => {
      if (it && it.translated === true) return cloneItem(it);
      const tr = resultByItem.get(it);
      if (!tr) {
        // 降级：中文字段 = 英文字段（绝不空），translated:false（schema §4 / D7）。
        return {
          ...it,
          title: { en: it.title.en, zh: it.title.en },
          summary: { en: it.summary.en, zh: it.summary.en },
          translated: false,
        };
      }
      return {
        ...it,
        title: { en: it.title.en, zh: tr.title },
        summary: { en: it.summary.en, zh: tr.summary },
        translated: true,
      };
    });
  };
}

// ── 批次内单请求（含差异化重试）──────────────────────────────────────────────

async function translateBatch(batch, { fetchImpl, apiKey, config }) {
  const body = buildRequestBody(batch, config);
  const headers = {
    'Content-Type': 'application/json',
    // 密钥只出现在本请求头；模块从不记录或打印它。
    Authorization: `Bearer ${apiKey ?? ''}`,
  };

  let statusAttempt = 0; // 429/5xx 与网络/超时：最多重试 2 次（共 3 次尝试）
  let parseAttempt = 0; // 畸形/不可对齐响应：最多重试 1 次（共 2 次尝试）

  while (true) {
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // 每次请求都配置超时（硬要求）。
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      // 网络错误 / 超时：视为瞬时错误，重试 2 次后降级该批。
      if (statusAttempt < 2) {
        statusAttempt++;
        await backoff(statusAttempt, config);
        continue;
      }
      return null;
    }

    if (authStatus(res.status)) {
      // 鉴权错误：配置问题，立即放弃、不重试，整个任务以可区分错误失败。
      const err = new Error(`translation auth failed (status ${res.status})`);
      err.name = 'TranslationAuthError';
      err.code = 'AUTH_FAILED';
      throw err;
    }

    if (!res.ok) {
      if (retryableStatus(res.status)) {
        if (statusAttempt < 2) {
          statusAttempt++;
          await backoff(statusAttempt, config);
          continue;
        }
        return null; // 重试耗尽 → 仅降级该批
      }
      // 其它 4xx（如 400/422）：不重试，降级该批（保持单批隔离）。
      return null;
    }

    // 2xx：尝试解析译文数组（宽容解析，模型偶尔把 JSON 包进代码围栏）。
    let arr;
    try {
      const content = await extractContent(res);
      arr = parseArrayTolerant(content);
    } catch {
      arr = null;
    }
    if (!isValidAlignment(arr, batch.length)) {
      // 畸形/不可对齐：仅重试 1 次；仍失败则降级该批，其余批次继续。
      if (parseAttempt < 1) {
        parseAttempt++;
        await backoff(parseAttempt, config);
        continue;
      }
      return null;
    }
    return arr;
  }
}

// ── 请求体构造（紧凑、按编号、要求严格 JSON 数组）────────────────────────────

function buildRequestBody(batch, config) {
  // 每条作为编号条目，模型据此按索引输出，便于对齐。
  const entries = batch
    .map((it, i) => {
      const t = String(it.title?.en ?? '').replace(/\s+/g, ' ').trim();
      const s = String(it.summary?.en ?? '').replace(/\s+/g, ' ').trim();
      return `${i + 1}. [TITLE] ${t}\n   [SUMMARY] ${s}`;
    })
    .join('\n');

  const system =
    '你是新闻翻译引擎，把英文新闻条目翻译成简体中文。严格只输出一个 JSON 数组，' +
    '数组长度等于输入条数，第 i 个元素对应第 i 条输入，元素为 {"title":"中文标题","summary":"中文摘要"}。' +
    '不要输出任何解释文字或 Markdown 代码围栏。原文摘要为空时输出空字符串。';

  const user =
    `把下面的新闻条目逐一翻译成中文，按编号 1..${batch.length} 一一对应输出 JSON 数组：\n\n${entries}`;

  return {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: config.temperature, // 0 → 确定性
    stream: false,
    // thinking 字段省略：glm-4-flash 非推理模型无深度思考开关（见 TRANSLATE_CONFIG 注释）。
  };
}

// ── 响应解析（宽容）────────────────────────────────────────────────────────

async function extractContent(res) {
  const raw = await res.text();
  let outer;
  try {
    outer = JSON.parse(raw);
  } catch {
    throw new Error('outer response is not JSON');
  }
  // 标准 OpenAI 兼容结构：choices[0].message.content 是我们要的译文 JSON（可能被围栏包裹）。
  const content = outer?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content field in response');
  return content;
}

function parseArrayTolerant(text) {
  let s = String(text).trim();
  // 去掉 ```json ... ``` 或 ``` ... ``` 围栏。
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) s = fenced[1].trim();
  // 容错：抽取第一个 [ 到最后一个 ]，吃掉前后多余散文。
  if (!s.startsWith('[')) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
  }
  return JSON.parse(s);
}

// 对齐校验：必须是数组、长度与批次一致、每个元素都是 {title, summary} 字符串。
function isValidAlignment(arr, n) {
  if (!Array.isArray(arr)) return false;
  if (arr.length !== n) return false;
  return arr.every(
    (e) => e && typeof e.title === 'string' && typeof e.summary === 'string',
  );
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cloneItem(it) {
  return { ...it, title: { ...it.title }, summary: { ...it.summary } };
}

function authStatus(status) {
  return status === 401 || status === 403;
}

function retryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

function backoff(attempt, config) {
  const ms = config.retryBaseMs * 2 ** (attempt - 1); // 指数递增
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 端点固定（也供测试构造请求 URL 断言）。
const ENDPOINT = TRANSLATE_CONFIG.endpoint;
