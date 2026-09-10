/* 卡片视差 —— 指针位置 → 每张卡片的屏幕位移
 *
 * 只写两个 CSS 自定义属性 --px / --py，卡片的位置公式留在 CSS 里：
 *   transform: translate(-50%,-50%) translate(--px,--py) rotate(θ) translateY(-R) scale(s)
 *
 * 这样布局与交互解耦：改扇形半径、改角度、改卡片尺寸都不用碰这个文件。
 *
 * 景深由页面通过 data-depth 给出（扇形外沿的卡片更大，看起来更近，动得更多），
 * 而不是脚本里按 |θ| 硬算——脚本不假设版式的几何形状。
 */

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/* 位移幅度同时受视口高与视口宽约束。
 *
 * 只按高度取值会在窄屏出事：400px 宽时扇形外侧卡片本来就贴着视口边，
 * 0.65×strength 的横向位移（最外侧 depth=1.3）足以把它推出去，
 * 表现就是"移动端卡片跑到屏幕外/压住底部文案"。
 * 加一条宽度上限后，桌面端（宽 ≥ 1400）仍由高度决定，行为不变。 */
const measure = () => {
  const vh = window.innerHeight || 800;
  const vw = window.innerWidth || 1200;
  const byHeight = Math.max(12, Math.min(46, vh * 0.038));
  const byWidth = Math.max(10, vw * 0.028);
  return Math.min(byHeight, byWidth);
};

/* X 方向位移大于 Y 方向：卡片是横向铺开的，横向跟手一点更自然 */
const RATIO_Y = 0.45;

export function createCardParallax(options) {
  const cards = options.cards ?? [];
  if (!cards.length || prefersReducedMotion()) {
    return { update() {}, dispose() {} };
  }

  let strength = options.strength ?? measure();
  const onResize = () => {
    strength = options.strength ?? measure();
  };
  window.addEventListener('resize', onResize, { passive: true });

  return {
    update(state) {
      const dx = (state.x - 0.5) * strength;
      const dy = (state.y - 0.5) * strength * RATIO_Y;
      for (const card of cards) {
        const depth = Number.parseFloat(card.dataset.depth ?? '1') || 1;
        card.style.setProperty('--px', `${(dx * depth).toFixed(2)}px`);
        card.style.setProperty('--py', `${(dy * depth).toFixed(2)}px`);
      }
    },
    dispose() {
      window.removeEventListener('resize', onResize);
    },
  };
}
