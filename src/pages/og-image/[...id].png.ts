// OG 分享图端点（2026-09-12，spec: blog-dark-og-code-mdx ③）
// 路由：/og-image/<post.id>.png，1200×630，档案卡构图。
// 链路：satori 出 SVG → @resvg/resvg-js 转 PNG；output: 'static' 下全量预渲染，
// 纯构建期产物、零运行时成本。实现参照 Cactus 的 og-image/[...slug].png.ts。
//
// 字体：Noto Sans CJK SC Bold 子集（GB2312 一级常用字 3755 + ASCII + CJK 标点，
// ~800KB）随仓库放 src/assets/og/——Cloudflare 构建机没有系统字体可用。
// 已知边界：文章标题若含子集外的生僻字，该字在分享卡上不渲染
// （satori 无字体回退链）；后续需要时重跑 qa/mk-og-font.sh 扩充字符集重生成。
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { html } from 'satori-html';
import { getSortedPosts, getFormattedDate } from '../../data/posts';

const fontData = fs.readFileSync(
  path.resolve('src/assets/og/NotoSansSC-Bold-subset.ttf'),
);

/** satori-html 走 HTML 解析，标题等动态文本必须转义 */
const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── 样式写法定死契约（2026-09-12 修构建红）──────────────────────
   ① 本机 satori-html@0.3.2 **不编译 `tw` 属性**（其 tw() 仅把 class 复制为 tw，
   satori 本体不认识 tw）——原 Cactus 式 tw 类全部无效，布局从未生效过；
   ② satori-html 给每个元素塞 children:[]（空数组为 truthy），satori 断言
   「div 的 children 是数组就必须显式 display:flex」——空 div（红色装饰条）
   也必须带 display，否则多标签文章触发构建红。故全部用内联 style。 */
const markup = (title, dateText, tagTexts, sectionText) => {
  /* 注意：html`` 模板字面量内不能写任何注释——模板里的注释（JS/JSX/HTML 形态
     都是）会被 ultrahtml 当成文本或注释节点渲染进卡片。说明只能写在模板外。 */
  const vdom = html`
    <div
      style="display:flex;flex-direction:column;width:100%;height:100%;background:#eeedeb;color:#131211;font-family:'Noto Sans SC'"
    >
      <div style="display:flex;flex:1;flex-direction:column;justify-content:space-between;padding:64px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center">
            <div style="display:flex;width:14px;height:38px;background:#cf0a1a;margin-right:20px"></div>
            <div style="font-size:26px;letter-spacing:8px">${'DAIDAI 档案馆 · ARCHIVE'}</div>
          </div>
          <div style="font-size:22px;letter-spacing:4px;color:#6f6f6f">${sectionText}</div>
        </div>
        <h1 style="font-size:62px;line-height:1.3;max-width:1060px;margin:0">${title}</h1>
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:24px;color:#55524e">
          <div style="letter-spacing:2px">${dateText}</div>
          <div style="display:flex;gap:14px" data-tags=""></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;height:76px;padding:0 64px;background:#131211;color:#f4f3f1;font-size:24px;letter-spacing:6px">
        <div>${'同一素材 · 同一交互 · 两种交付格式'}</div>
        <div>${'OPEN TO WORK'}</div>
      </div>
    </div>`;

  const chips = tagTexts.map((t) => ({
    type: 'div',
    props: {
      style: {
        padding: '4px 16px',
        border: '2px solid #cf0a1a',
        borderRadius: '999px',
        color: '#cf0a1a',
        fontSize: '20px',
      },
      children: t,
    },
  }));
  const findTagsHost = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['data-tags'] !== undefined) return node;
    for (const child of node.props?.children ?? []) {
      if (typeof child === 'object') {
        const hit = findTagsHost(child);
        if (hit) return hit;
      }
    }
    return null;
  };
  const host = findTagsHost(vdom);
  if (!host) throw new Error('og-image: data-tags 容器未找到（模板被改动？）');
  host.props.children = chips;
  delete host.props['data-tags'];
  return vdom;
};

export async function getStaticPaths() {
  const posts = await getSortedPosts();
  // 与列表页同源倒序：i=0 即最新（NO.01），保证卡面编号与列表跨页连续编号一致
  return posts.map((post, i) => ({
    params: { id: post.id },
    props: { post, no: String(i + 1).padStart(2, '0') },
  }));
}

export async function GET({ props }) {
  const { post, no } = props;
  // 全部预拼成完整字符串（见 markup 上方 satori 多子节点坑）
  const dateText = `${getFormattedDate(post.data.publishDate)} 发布`;
  const sectionText = `NO.${no} 博客专栏`;
  const tagTexts = post.data.tags
    .slice(0, 3)
    .map((t) => `#${esc(t)}`);

  const svg = await satori(markup(esc(post.data.title), dateText, tagTexts, sectionText), {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'Noto Sans SC',
        data: fontData,
        weight: 700,
        style: 'normal',
      },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
    .render()
    .asPng();
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
