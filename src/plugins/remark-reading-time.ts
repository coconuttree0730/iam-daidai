/**
 * 阅读时长估算（无外部依赖，参照 Cactus 的 remark-reading-time 思路重写）：
 * 遍历 mdast 统计正文文本字符数（含代码块/行内代码），
 * 按中文 ~400 字/分钟折算，向上取整且至少 1 分钟。
 * 结果注入 remarkPluginFrontmatter.minutes，详情页经 render() 消费
 * （注意：getCollection 的 post.data 不含它——zod schema 未声明该键）。
 * @param {import('mdast').Root} tree
 * @param {import('vfile').VFile} file
 */
export default function remarkReadingTime() {
	return (tree, file) => {
		let chars = 0;
		const visit = (node) => {
			if (!node) return;
			if (node.type === 'text' || node.type === 'code' || node.type === 'inlineCode') {
				chars += (node.value || '').length;
			}
			if (Array.isArray(node.children)) node.children.forEach(visit);
		};
		visit(tree);
		file.data.astro.frontmatter.minutes = Math.max(1, Math.round(chars / 400));
	};
}
