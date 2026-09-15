// 数据文件路径解析 + 读写 + 空骨架。所有路径从 config.dataDir 解析，不各写一遍。
// 硬规则：不写时不打开任何文件用于写入（规格 D18 字面意义的「不写文件」）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.mjs';

// 路径解析：current.json 与 archive/YYYY-MM.json
export function resolvePaths(config = CONFIG) {
  const base = config.dataDir;
  return {
    base,
    current: path.join(base, 'current.json'),
    archiveDir: path.join(base, 'archive'),
    archive: (month) => path.join(base, 'archive', `${month}.json`),
  };
}

// current.json 冷启动空骨架（updated = null，items = []）
export function emptySkeleton() {
  return {
    _comment:
      'AI 新闻时间线 —— 当前窗口冷启动空骨架。本文件由 scripts/ai-news/run.mjs 离线生成，不要手改：抓取结果少于阈值时脚本不写文件，宁可保留上一次快照，也不写坏数据。',
    updated: null,
    items: [],
  };
}

// archive/YYYY-MM.json 冷启动空骨架（无 updated，按规格 D14 与 current 同构）
export function emptyArchiveSkeleton(month) {
  return {
    _comment:
      'AI 新闻归档空骨架。被当前窗口挤出的条目滚入这里，历史不丢失。结构与 current.json 完全一致。',
    month,
    items: [],
  };
}

export async function readWindow(config = CONFIG) {
  const { current } = resolvePaths(config);
  try {
    return JSON.parse(await fs.readFile(current, 'utf8'));
  } catch {
    return emptySkeleton();
  }
}

export async function readArchive(month, config = CONFIG) {
  const file = resolvePaths(config).archive(month);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return emptyArchiveSkeleton(month);
  }
}

export async function writeWindow(data, config = CONFIG) {
  const { current } = resolvePaths(config);
  await fs.writeFile(current, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function writeArchive(month, data, config = CONFIG) {
  const paths = resolvePaths(config);
  await fs.mkdir(paths.archiveDir, { recursive: true }); // 首次写入时递归建 archive/
  await fs.writeFile(paths.archive(month), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// 真正落地磁盘的实现，作为 pipeline 的默认 store。
export const realStore = {
  readWindow: () => readWindow(),
  readArchive: (month) => readArchive(month),
  writeWindow: (data) => writeWindow(data),
  writeArchive: (month, data) => writeArchive(month, data),
};
