/* ── 博客全文检索挂载（Pagefind default-ui + 自定义圆圈 × 清除按钮）──
 *
 * 2026-09-15 从 blog/[...page].astro 的内联 <script> 抽出：英文版博客页
 * （/en/blog/）也挂检索框，两页脚本完全同构、只差 UI 文案——不抽会变成
 * 两份必须手工同步的 100 行脚本。
 *
 * 页面侧契约：
 *   <div class="search-mount" id="search-mount" data-pf-i18n='<JSON>'></div>
 *   <p class="search-status" data-search-status hidden></p>
 *   <script> import { mountBlogSearch } from '...'; mountBlogSearch({...}) </script>
 *
 * 文案解析顺序（i18n 第 2 期约定）：data-pf-i18n（SSR 写进的 JSON）→
 * fallback（页面传入的语言兜底）→ default-ui 自带英文。script 引用不到
 * frontmatter 的 t()，只能靠 data 属性序列化传值。
 */

const DEFAULT_BASE = '/pagefind/';

export async function mountBlogSearch({ mountEl, statusEl, fallback, devNotice, failNotice }) {
  /* 挂载点缺失时静默退出（与旧版 if (mountEl) 守卫同义），不进 catch 报错 */
  if (!mountEl) return;

  const show = (el) => el && el.removeAttribute('hidden');

  let dict = {};
  try {
    dict = JSON.parse(mountEl?.dataset.pfI18n || '{}');
  } catch {
    dict = {};
  }
  const pf = (k) => dict[k] ?? fallback[k];

  const { PagefindUI } = await import('@pagefind/default-ui');
  new PagefindUI({
    element: mountEl,
    bundlePath: import.meta.env.BASE_URL.replace(/\/$/, '') + DEFAULT_BASE,
    /* resetStyles 默认 true 会向 <head> 注入全局重置，可能波及站内样式，关掉 */
    resetStyles: false,
    showSubResults: true,
    excerptLength: 20,
    /* 占位符必须是 default-ui 的令牌：它只做
       `.replace(/\[SEARCH_TERM\]/)` 与 `.replace(/\[COUNT\]/)`，
       旧文案写的 [QUERY] 原样印在页面上（2026-09-13 用户截图暴露）。 */
    translations: {
      placeholder: pf('placeholder'),
      clear_search: pf('clear'),
      load_more: pf('loadMore'),
      search_label: pf('search'),
      filters_label: pf('filter'),
      zero_results: pf('zero'),
      one_result: pf('count'),
      many_results: pf('count'),
      searching: pf('searching'),
      error_searching: pf('searchErr'),
    },
  });

  // default-ui 渲染的是文本「清空」按钮；替换为圆圈 ×
  const input = mountEl.querySelector('.pagefind-ui__search-input');
  const nativeClear = mountEl.querySelector('.pagefind-ui__search-clear');
  if (!input) return;

  /* 圆圈 × 挂进 default-ui 的 <form> 而不是 .search-mount：form 是
     position:relative 且顶边 == 输入框顶边，绝对定位才能钉在输入框行内；
     .search-mount 把结果抽屉也包在内（结果区在 form 里），随结果长高会把
     绝对定位的按钮一路带下去——2026-09-13 用户截图里的「下方方块 ×」
     就是这个按钮既没拿到样式、又落在了结果区之下。 */
  const anchor = mountEl.querySelector('.pagefind-ui__form') ?? mountEl;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'search-clear';
  clearBtn.title = pf('clearSearch');
  clearBtn.setAttribute('aria-label', pf('clearSearch'));
  clearBtn.innerHTML =
    '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
    '<path d="M1 1l10 10M11 1L1 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>' +
    '</svg>';
  anchor.appendChild(clearBtn);

  const sync = () => {
    clearBtn.hidden = !input.value;
  };
  input.addEventListener('input', sync);
  clearBtn.addEventListener('click', () => {
    /* 优先走 default-ui 自己的清除逻辑（清 val + 收起结果抽屉，节点常驻
       DOM 只是被 suppressed 透明化，故引用长期有效）；失败则手动清空 +
       派发 input 让 UI 走同一条响应链。 */
    if (nativeClear?.isConnected) nativeClear.click();
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.focus();
    sync();
  });
  sync();

  /* dev 也挂载：cactus 原版在 dev 直接 return 不装 UI，但 dev 看不到真实
     版式等于盲区。改为 dev 照常挂载输入框、状态行解释「无索引」；输入后
     UI 内部报「检索出错」是 dev 预期行为（/pagefind/ 产物只在构建链生成）。 */
  if (import.meta.env.DEV && devNotice) {
    show(statusEl);
    statusEl.textContent = devNotice;
  }
}

/* 生产环境挂载失败的统一外显（含 chunk 加载失败），不静默吞掉。
   调用方式见各博客列表页的 <script>。 */
export function reportSearchFailure(statusEl, failNotice, err) {
  if (!statusEl) return;
  statusEl.removeAttribute('hidden');
  statusEl.textContent = failNotice(err?.message ?? err);
}
