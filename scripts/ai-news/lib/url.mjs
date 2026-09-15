// URL 规范化与去重主键（schema §6）。纯函数，输入输出皆字符串，可单测。
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

// 追踪参数：去掉后不改变页面内容（§6.3）。来源见 §6.3 列表，这里尽量覆盖常见项
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_reader', 'utm_brand',
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'mc_cid', 'mc_eid',
  'ref', 'ref_src', 'ref_', 'source', 'campaign', 'igshid',
]);

// 规范化一条 URL 为去重主键来源，严格按 §6 七步执行。
// 解析失败 → 原样返回（不抛错；主键仍能算出来，只是去重能力退化，§6.1）
export function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return raw ?? '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }

  // §6.2 去 fragment（#…）
  u.hash = '';

  // §6.3 去追踪参数
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }

  // §6.4 其余查询参数按 key 排序后重拼（顺序不同不应产生两条）
  const entries = [...u.searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  u.search = '';
  for (const [k, v] of entries) u.searchParams.append(k, v);

  // §6.5 host 小写；去掉默认端口（:80 / :443）
  u.hostname = u.hostname.toLowerCase();
  if (u.port === '80' || u.port === '443') u.port = '';

  // §6.6 去末尾 /（根路径 / 保留）
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  // §6.7 去掉 www. 前缀
  if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4);

  return u.toString();
}

// 去重主键 = sha256(规范化 URL) 的前 12 位十六进制（schema §4 id / D9）
export function urlKey(raw) {
  return createHash('sha256').update(normalizeUrl(raw)).digest('hex').slice(0, 12);
}
