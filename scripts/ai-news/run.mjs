// CLI 入口 —— 唯一触碰真实全局 fetch / process.env / process.exitCode 的地方。
// 自带超时与礼貌 User-Agent；抓取为「逐源一次 GET」（见 lib/source.mjs）。
// 真实网络只在 run.mjs 里发生；--dry-run 用内存假 store 跑完整管线，不落盘、不污染仓库。
//
// ⛔ **本管线不接入任何 LLM**（2026-09-15 站长裁定）：曾经的 GLM 翻译接线（`createEnricher`
// + `GLM_API_KEY` + `config.translate`）已整条删除，别再引入。数据 = 源站原文，零第三方数据流、
// 零密钥依赖。原因见 `config.mjs` 的同名注释与 SCHEMA.md §8。
import { runPipeline } from './pipeline.mjs';
import { realStore } from './lib/store.mjs';
import { createRollover } from './lib/archive.mjs';
import { CONFIG } from './config.mjs';

// 礼貌 UA：识别本脚本，便于源站联系/限速
const USER_AGENT = 'iam-daidai-ai-news/1.0 (+https://github.com/daidai/iam-daidai)';

// 真实 fetch 包装：默认超时 + 礼貌 UA。
// ⚠️ **必须转发 init**：调用方在 init 里指定 signal（每源的 fetchTimeoutMs）。
// 早先本函数只接一个 url 参数、把 init 丢掉，那会让逐源超时静默失效——故此处显式合并 init。
async function realFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

// 内存假 store：记录是否发生过写，供 --dry-run 自检用（断言不写盘）。
// readArchive(month) 的签名与真实 store 对齐——归档模块按月份逐个读，
// 返回 { month, items } 而不是一张月→桶的映射表。
function makeFakeStore() {
  return {
    writes: 0,
    archives: 0,
    async readWindow() {
      return { updated: null, items: [] };
    },
    async readArchive(month) {
      return { month, items: [] };
    },
    async writeWindow() {
      this.writes++;
    },
    async writeArchive() {
      this.archives++;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const store = dryRun ? makeFakeStore() : realStore;

  // ── ticket 05：按月归档滚动 ──────────────────────────────────────────
  // 用工厂把 store 闭包进去，pipeline 的 rollover 钩子签名（只收 { window, now, config }）
  // 因此不需要改动。
  const rollover = createRollover({ store });

  const result = await runPipeline({
    fetchImpl: realFetch,
    now: new Date(),
    config: CONFIG,
    store,
    rollover,
  });

  // 源级明细：换源后「哪几个源通了、各拿到几条」是排查稳定性问题的一手信息，
  // 无条件打印（不含任何敏感信息）。
  console.log(`源状态：${result.sources ?? '-'}`);

  if (dryRun) {
    console.log(
      `[dry-run] status=${result.status} fetched=${result.fetched} kept=${result.kept} reason=${result.reason ?? '-'}`,
    );
    console.log(
      `[dry-run] 假 store 写入次数 = ${store.writes}（>0 仅表示管线走到了写盘分支，未触碰真实磁盘）`,
    );
    return;
  }

  if (result.status === 'unchanged') {
    // 内容与上轮完全一致 → 整条不写盘（规格 D35），workflow 的 git diff 判定因此为真、
    // 跳过提交。**这不是失败**：源站这段时间没出新内容而已，以成功状态退出。
    console.log(`unchanged: ${result.kept} 条与上轮完全一致，未写盘（workflow 将跳过提交）`);
    process.exitCode = 0;
    return;
  }

  if (result.status === 'skipped') {
    // 静默失败：成功退出，保留上次快照（规格 D18，退出码 0 是刻意的）
    console.log(`skipped: ${result.reason ?? ''}（保留上次快照）`);
    process.exitCode = 0;
    return;
  }

  const archived = (result.archives ?? []).reduce((n, a) => n + (a.items?.length ?? 0), 0);
  console.log(
    `written: ${result.kept} 条, 归档 +${archived} 条, updated=${result.updated}`,
  );
  process.exitCode = 0;
}

main().catch((err) => {
  // 绝不打印完整 error 对象 / 环境变量 / 请求头
  console.error(`pipeline error: ${err?.message ?? 'unknown'}`);
  process.exitCode = 1;
});
