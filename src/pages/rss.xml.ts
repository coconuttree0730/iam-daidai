import rss from '@astrojs/rss';
import { getSortedPosts } from '../data/posts';

/** 站点 RSS 订阅源（/rss.xml），参照 Cactus 主题的同名端点 */
export async function GET(context) {
	const posts = await getSortedPosts();
	return rss({
		title: 'Daidai 档案馆',
		description: '把喜欢的事做成日常——博客文章更新',
		site: context.site,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			link: `/blog/${post.id}/`,
			pubDate: post.data.publishDate,
			categories: post.data.tags,
		})),
		customData: '<language>zh-CN</language>',
	});
}
