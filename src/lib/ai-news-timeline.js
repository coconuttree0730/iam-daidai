// AI 新闻时间线 —— 年份切换运行时（LAB-NEWS 06，2026-09-15 纵向改版）
//
// ⚠️ 2026-09-15 版式从「横向轨道」改成「纵向时间线」后，本模块**删掉了整套横向机制**：
// overflow-x 滚动容器、鼠标拖拽 + 惯性、‹ › 箭头、←→/Home/End 键盘处理、
// 可聚焦的 role=region。理由：纵向版式下这些全部失去对象 —— 页面滚动就是浏览器
// 原生纵向滚动，零接管。这恰好消掉了规格 D23 里最重的一块复杂度
// （「不接管滚轮、不 preventDefault，否则手机上翻不动页」的整套约束）。
//
// 剩下的唯一职责：**年份切换**（D24 零网络请求 / D25 首屏只渲最新年份）。
// 与版式完全无关：只认 .news-rail / .news-list / .news-yearbtn 三个选择器，
// 所以「>900px 中央轴交错 / ≤900px 左轴单栏」两套形态共用同一份逻辑。

export function mountNewsTimeline({ root } = {}) {
  if (!root) return;
  const railEl = root.querySelector('.news-rail');
  if (!railEl) return;
  const yearBtns = Array.from(root.querySelectorAll('.news-yearbtn'));
  if (!yearBtns.length) return; // 单年份时页面不渲染年份切换器，无需挂载

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentYear = railEl.querySelector('.news-list')?.dataset.newsYear || null;

  const tplFor = (year) => root.querySelector(`template[data-news-year="${year}"]`);

  // 换年后把视图带回时间线顶部。横向版的对应物是 scrollLeft = 0；
  // 纵向版没有自己的滚动容器，对应物是 window 滚动位置 —— 因此只在
  // 「时间线顶部已被滚到视口上方」时才回卷，避免读者本来就在顶部、
  // 一按年份页面却无故跳一下。
  function resetView() {
    const top = railEl.getBoundingClientRect().top + window.scrollY - 24;
    if (window.scrollY - top > 48) {
      window.scrollTo({ top: Math.max(0, top), behavior: reduce.matches ? 'auto' : 'smooth' });
    }
  }

  // ── 年份切换：仅做 DOM 显隐，零网络请求（规格 D24）──
  // 非当前年份的条目在构建期已塞进 <template data-news-year>；
  // 切换时把活的 .news-list 移回它自己的 template、再把目标 template 的
  // .news-list clone 进活的挂载点。
  // HTML 体积随历史增长（D24 接受），但首屏只渲染最新年份、其它年份不进
  // 可访问性树也不参与布局/绘制，首屏成本恒定（D25）。
  function switchYear(year) {
    if (!year || String(year) === String(currentYear)) return;
    const liveList = railEl.querySelector('.news-list');
    if (!liveList) return;
    // 把当前活的列表存回它自己的 template（没有则新建，挂在根节点下）
    let curTpl = tplFor(currentYear);
    if (!curTpl && currentYear) {
      curTpl = document.createElement('template');
      curTpl.setAttribute('data-news-year', String(currentYear));
      root.appendChild(curTpl);
    }
    if (curTpl) curTpl.content.appendChild(liveList);
    // 取出目标年份的列表（clone，template 内容可反复复用）
    const tgt = tplFor(year);
    if (!tgt) return;
    const fresh = tgt.content.querySelector('.news-list');
    if (!fresh) return;
    railEl.appendChild(fresh.cloneNode(true));
    currentYear = year;
    // 更新视图切换按钮的选中态（这些是 view switch，非链接）
    yearBtns.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.year === String(year)));
    });
    resetView();
  }

  yearBtns.forEach((b) => {
    b.addEventListener('click', () => switchYear(b.dataset.year));
  });
}
