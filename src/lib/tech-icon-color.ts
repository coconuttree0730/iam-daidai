// ── 技术栈品牌图标的明暗适配（2026-09-15 建）──────────────────────────
//
// 为什么不能靠 CSS filter：simple-icons 给的是**官方品牌色**，两端都会翻车——
//   · 纯黑品牌（OpenJDK / GitHub / IntelliJ IDEA 取值在 #000000～#181717）：
//     brightness() 是乘算，0 × 任何系数仍是 0，暗色主题下整个图标不可见。
//   · 亮黄品牌（JavaScript #F7DF1E / Linux #FCC624 / Pinia #FFD859）：
//     纸白卡片（--c-card #fdfdfc）上对比度不足，图形糊成一团。
// 所以按**感知亮度**把品牌色收敛到两端都安全的区间，产出 --brand（亮色主题）
// 与 --brand-dark（暗色主题）两个 hex，由 basic-drawer.css 消费。
//
// 收敛用"朝黑/朝白迭代混色"而非一次乘系数：一次乘系数对 #000000 依然无效，
// 迭代则保证无论原色多极端都能落进区间内（循环上限防死循环）。
//
// 纯函数、无 DOM 依赖、构建期调用一次，可直接单测。

export interface BrandColor {
  /** 亮色主题下的图标色 */
  brand: string;
  /** 暗色主题下的图标色 */
  brandDark: string;
  /** 亮色主题下 tile 风格的淡色底 */
  bg: string;
  /** 暗色主题下 tile 风格的淡色底 */
  bgDark: string;
}

/** 亮色主题亮度上限：超出则在纸白卡片上对比不足 */
const LUMA_MAX_LIGHT = 160;
/** 暗色主题亮度下限：低于则在深色卡片上看不见 */
const LUMA_MIN_DARK = 150;

const hexToRgb = (hex: string): [number, number, number] => {
  let s = hex.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [
    parseInt(s.slice(0, 2), 16) || 0,
    parseInt(s.slice(2, 4), 16) || 0,
    parseInt(s.slice(4, 6), 16) || 0,
  ];
};

const rgbToHex = (rgb: number[]): string =>
  '#' +
  rgb
    .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0'))
    .join('');

/** 感知亮度（BT.601 加权）。不做 sRGB 线性化——这里只取"浅/深底上是否可读"的排序。 */
const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

export function brandFor(hex: string): BrandColor {
  const base = hexToRgb(hex);

  let light = base;
  for (let s = 0.15; s <= 0.75 && luma(light) > LUMA_MAX_LIGHT; s += 0.1) {
    light = mix(base, [0, 0, 0], s);
  }

  let dark = base;
  for (let s = 0.15; s <= 0.9 && luma(dark) < LUMA_MIN_DARK; s += 0.12) {
    dark = mix(base, [255, 255, 255], s);
  }

  const l = light.map(Math.round);
  const d = dark.map(Math.round);
  return {
    brand: rgbToHex(l),
    brandDark: rgbToHex(d),
    bg: `rgba(${l.join(',')}, 0.13)`,
    bgDark: `rgba(${d.join(',')}, 0.16)`,
  };
}
