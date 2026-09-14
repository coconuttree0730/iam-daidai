/**
 * 外链处理（rehype 插件，2026-09-14 建；零外部依赖，手写遍历 hast）
 * ────────────────────────────────────────────────────────────────────────
 * 给正文里的**站外链接**自动补上：
 *   · target="_blank"
 *   · rel="noopener noreferrer"
 *   · class="ext-link"（供 prose 样式加视觉标记，如尾随 ↗）
 * 站内链接（相对路径、站内绝对路径、同域绝对 URL、锚点、mailto/tel）一律不动。
 *
 * 为什么手写而不用 rehype-external-links：本项目的插件都走「无外部依赖」路线
 * （见 remark-reading-time.ts），且判定规则就下面那几条，没必要为一个 40 行的
 * 遍历引入一个包。
 *
 * ⚠️ 判定口径：以 `http://` / `https://` 开头 **且** 主机名不等于站点主机
 * 的绝对 URL 才算外链。用 `Astro.site` 的 host 做比对，而不是硬编码域名——
 * 域名换了插件不用改。
 *
 * @param {{ siteOrigin?: string }} [options] 站点 origin（含协议），用于判定同域
 */

const EXTERNAL_RE = /^https?:\/\//i;

/** 纯锚点 / 协议类链接：永远不是外链 */
const NON_HTTP_RE = /^(#|mailto:|tel:|javascript:)/i;

function getHref(node) {
  const props = node.properties || {};
  const href = props.href;
  return typeof href === 'string' ? href : '';
}

/**
 * 判定是否外链。origin 形如 'https://daidai.click'（无尾斜杠）。
 * 拿不到 origin（Astro.site 未配置）时退化为「协议开头即外链」。
 */
function isExternal(href, origin) {
  if (!href) return false;
  if (NON_HTTP_RE.test(href)) return false;
  if (!EXTERNAL_RE.test(href)) return false; // 站内相对路径 / 站内绝对路径
  if (!origin) return true;
  // 同域绝对 URL：解析后按 origin 比对（大小写与默认端口由 URL 构造器归一）
  try {
    return new URL(href).origin !== new URL(origin).origin;
  } catch {
    return true; // 解析失败时保守当作外链
  }
}

export default function rehypeExternalLinks(options = {}) {
  const origin = options.siteOrigin ?? '';

  return (tree) => {
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'element' && node.tagName === 'a') {
        const href = getHref(node);
        if (isExternal(href, origin)) {
          node.properties = node.properties || {};
          node.properties.target = '_blank';
          // noopener 防 tabnabbing；noreferrer 顺带去掉 Referer 头
          node.properties.rel = 'noopener noreferrer';
          // 与已有 class 合并（mdx 里可能已经手写了 class）
          const existing = node.properties.className;
          const list = Array.isArray(existing)
            ? existing
            : existing
              ? [String(existing)]
              : [];
          if (!list.includes('ext-link')) list.push('ext-link');
          node.properties.className = list;
        }
      }

      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(tree);
  };
}
