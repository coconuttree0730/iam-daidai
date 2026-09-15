// RSS 2.0 / Atom 容错解析器（零依赖，纯函数，可单测）。
//
// ── 为什么不用严格 XML 解析器 ─────────────────────────────────────────
// 实测：白名单外的大量中文源是**非规范 XML**（未闭合标签、裸 & 、非法字符），
// 严格解析器直接抛错 → 该源静默变成 0 条，而且看上去和「今天没新闻」一模一样。
// 这里的策略是**提取而非校验**：按 <item>/<entry> 切块，块内按标签取字段，
// 缺字段、格式不标准都不报错，只把那条降级。对内容源这种「对方改版我无法干预」的场景，
// 容错比正确性更重要——宁可少几个字段，也不要整源归零。
//
// 已验证可解析的真实格式（2026-09-15 实测）：
//   · RSS 2.0：量子位 +0000 · IT之家 GMT · 爱范儿/极客公园 · arXiv -0400
//   · Atom：<entry> + <link href> 变体
//   · 自闭合 <link href="…"/> 与文本 <link>…</link> 两种
//
// 明确的局限（有意接受）：不做完整 XML 语义解析，因此
//   · 嵌套同名标签（罕见）会取到最外层
//   · 命名空间前缀按字面保留（dc:date / content:encoded 已在下方显式列出）

// XML 命名实体 + 数字实体 → 原字符
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const hit = NAMED[body.toLowerCase()];
    return hit ?? m;
  });
}

// 剥掉 <![CDATA[ … ]]> 外壳（不递归：CDATA 内不会再嵌 CDATA）
export function unwrapCdata(s) {
  return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// 去标签：script/style 整块丢弃，其余标签换成空格（避免 "a</b><b>b" 粘成一个词）
export function stripTags(s) {
  return String(s ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

// 统一文本清洗：CDATA → 去标签 → 解实体 → 折叠空白
export function cleanText(s) {
  return decodeEntities(stripTags(unwrapCdata(s))).replace(/\s+/g, ' ').trim();
}

// 取第一个「有内容」的标签值；names 按优先级排列
function pickText(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
    const m = block.match(re);
    if (m) {
      const v = cleanText(m[1]);
      if (v) return v;
    }
  }
  return '';
}

// 取全部同名标签的清洗值（用于摘要候选）
function allText(block, names) {
  const out = [];
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
    for (const m of block.matchAll(re)) {
      const v = cleanText(m[1]);
      if (v) out.push(v);
    }
  }
  return out;
}

// 链接提取，兼容两种写法：
//   Atom：<link rel="alternate" href="https://…"/>（无文本，地址在属性里）
//   RSS ：<link>https://…</link>（地址在文本里）
// 优先取 rel 缺省或 rel="alternate" 的那条 —— rel="self"/"replies" 指向 feed 自身或评论，
// 拿错会让整条新闻链到错误位置。
export function pickLink(block) {
  const selfClosing = [...block.matchAll(/<link\b([^>]*)>/gi)]
    .map((m) => ({
      attrs: m[1],
      href: (m[1].match(/href\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? '',
    }))
    .filter((x) => x.href);

  const preferred = selfClosing.find(
    (x) => !/\brel\s*=/i.test(x.attrs) || /\brel\s*=\s*["']alternate["']/i.test(x.attrs),
  );
  if (preferred) return decodeEntities(preferred.href).trim();

  const textual = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (textual) {
    const v = cleanText(textual[1]);
    if (v) return v;
  }
  return selfClosing[0] ? decodeEntities(selfClosing[0].href).trim() : '';
}

// 日期 → ISO 字符串；无法解析返回 null（上层回退 fetchedAt，见 schema §5）。
// 不自己写 strptime：JS 原生 Date 已覆盖 RFC822（"Tue, 15 Sep 2026 12:10:52 GMT" /
// "… +0800" / "… -0400"）与 ISO 8601（Atom）两种实际出现的格式，实测各源全部命中。
export function toIso(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function blockToItem(block, { strip } = {}) {
  const title = pickText(block, ['title']);
  const url = pickLink(block);
  const publishedAt = toIso(
    pickText(block, ['pubDate', 'published', 'updated', 'dc:date', 'date']),
  );

  // 摘要候选：description / summary / content:encoded / content 全收，然后**取最短的一条**。
  // 为什么不按标签优先级取：同一份 feed 里 description 可能是导语、content:encoded 是全文，
  // 但也可能反过来。「最短的非空值」在两种排布下都命中「发布方本想给你的那句摘要」，
  // 而取到全文会让「摘要」名不副实（这正是本项要防的风险）。
  const candidates = allText(block, ['description', 'summary', 'content:encoded', 'content']);
  let summary = candidates.length ? candidates.reduce((a, b) => (b.length < a.length ? b : a)) : '';
  if (strip) summary = summary.replace(strip, '').trim();

  return { title, url, publishedAt, summary };
}

// 主入口：feed 文本 → 原始条目数组。非 feed（HTML 页面等）返回空数组，不抛错。
// strip 来自源配置（可选），用于剥掉正文前缀噪声（如 arXiv 的公告抬头）。
export function parseFeed(xml, { strip } = {}) {
  const text = String(xml ?? '');
  if (!text) return [];
  const blocks = [
    ...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  return blocks
    .map((b) => blockToItem(b, { strip }))
    .filter((it) => it.title);
}
