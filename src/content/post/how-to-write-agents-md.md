---
title: 如何写出 AI Agent 真正遵循的 AGENTS.md / CLAUDE.md
description: 结合 writing-for-agents 技能原理与 2026 社区实践，提炼一份可操作的 Agent 指令文件写作指南。
publishDate: 2026-09-13
category: AI
featured: true
tags:
  - ai
  - agents
  - development
  - tools
draft: false
---

# 如何写出 AI Agent 真正遵循的 AGENTS.md / CLAUDE.md ?

> 同样的规则、同样的长度、同样的结构，换个项目就失效——问题不在 Agent，在你写给它的文档。

---

## 0. 这份教程在解决什么问题

你可能已经试过：把编码规范、项目架构、命令列表全塞进 `AGENTS.md` 或 `CLAUDE.md`，然后发现 Agent 照样犯错。你加更多规则，文件膨胀到 500 行，Agent 的遵守率反而下降。

这不是 Agent 笨。这是**文档的写法**出了问题。

本文将 `writing-for-agents` 技能的底层原理（信息层次、前导词、剪枝）与 2026 年社区实践（GitHub 对 2500+ 仓库的分析、Anthropic 官方建议）合并，提炼出一份可操作的写作指南。

---

## 1. 先搞清楚：AGENTS.md 和 CLAUDE.md 分别是什么

| 文件 | 谁读 | 核心区别 |
|------|------|----------|
| `AGENTS.md` | Codex、Cursor、Copilot、Windsurf、Gemini CLI、Aider 等 18+ 工具 | **跨工具开放标准**，所有工具通用 |
| `CLAUDE.md` | Claude Code 专属 | 支持 `@import`、路径级规则、本地覆盖文件 |

**实用建议**：

- 团队用多个工具 → `AGENTS.md` 作为真实来源，`CLAUDE.md` 里一行 `@AGENTS.md` 导入
- 只用 Claude Code → 直接写 `CLAUDE.md`，不用管 `AGENTS.md`
- 从零开始 → 先写 `AGENTS.md`，它是行业共识

两者格式都是纯 Markdown，没有强制 schema。

---

## 2. 核心原则：两个负载

`writing-for-agents` 技能提出了一个关键框架——每加一行字，你都在消耗两种预算之一：

### 上下文负载（Context Load）

Agent 每次对话都会把文件内容加载到上下文窗口。一行字在 30 轮对话里就是 30 次 token 消耗。**每一行都要问：删掉它，Agent 会不会犯错？** 如果答案是"不会"，删掉。

Anthropic 建议 `CLAUDE.md` 不超过 **200 行**。Codex 的硬上限是 32KB。实践中 50-100 行是最佳区间。

### 认知负载（Cognitive Load）

这是人的负担——你要记住哪份文档存在、什么时候该用。**文档不是越少越好**，而是要把认知负载花在人类判断真正重要的地方，消除不必要的地方。

```text
永远在上下文中    →  AGENTS.md / CLAUDE.md（上下文负载）
只在需要时才加载  →  技能文件、docs/ 目录（靠指针触发）
没有任何指向      →  只能靠人脑记住（认知负载）
```

---

## 3. 信息层次：什么放进来，什么推到后面

这是整份文档的核心决策。所有内容分为两类：

- **步骤**（Steps）：Agent 按顺序执行的动作
- **参考**（Reference）：定义、规则、事实，按需查阅

它们在**信息层次**上有三个位置：

| 层级 | 含义 | 例子 |
|------|------|------|
| **文件内步骤** | Agent 立即需要的有序动作 | 构建命令、测试流程 |
| **文件内参考** | 按需查阅的规则集合 | 代码风格、命名约定 |
| **披露引用** | 推到单独文件，靠指针触发 | 完整架构文档、部署手册 |

### 分支测试（最实用的判断方法）

> 内联每个分支都需要的东西，把只有部分分支才用到的东西推到指针后面。

例子：如果你的 `AGENTS.md` 里有一段"前端代码风格"，但 Agent 50% 的时间在改后端——这段内容应该被披露引用，而不是永远加载。

![分支测试：全部分支都需要的内容内联，只有部分分支需要的推到指针后面](/blog/how-to-write-agents-md/branch-test.jpeg)

---

## 4. 六个核心章节：社区共识

GitHub 分析 2500+ 仓库后发现，有效的 `AGENTS.md` 一致覆盖六个领域：

### 4.1 命令（Commands）— 最高 ROI

```markdown
## 命令

- 安装依赖：`pnpm install --frozen-lockfile`
- 开发服务器：`pnpm dev`（端口 3000）
- 单文件测试：`pnpm test --filter <package-name>`
- 类型检查：`pnpm typecheck`
- 全量测试：`pnpm test`（约 18 分钟，仅在单文件测试通过后运行）
```

**关键**：写完整的命令和标志，不要只写工具名。"Run the tests" 没用；`pnpm test --filter api` 有用。

### 4.2 边界（Boundaries）— 三级模型

```markdown
## 边界

### 始终执行
- 每次修改后运行相关类型的检查
- 提交前确认所有测试通过

### 需要询问
- 添加生产环境依赖
- 修改数据库迁移文件

### 禁止操作
- 不要直接编辑 `src/generated/`；改 schema 然后运行 `pnpm generate`
- 不要修改已有的迁移；新增迁移
- 不要提交包含密钥的文件
```

三级模型（始终做 / 先问 / 禁止）是 2026 年社区验证过的最有效模式。

![三级边界模型：始终执行、需要询问、禁止操作——先判断再动手](/blog/how-to-write-agents-md/boundaries.jpeg)

### 4.3 项目结构（Structure）

```markdown
## 结构

- `src/api/` — API 路由处理器
- `src/core/` — 业务逻辑和领域模型
- `src/db/` — SQLAlchemy 模型和迁移
- `src/external/` — 外部服务集成
- `packages/shared/` — 跨包共享类型，禁止引入框架依赖
```

### 4.4 代码风格（Code Style）— 用代码示例，别写散文

```markdown
## 风格

- TypeScript strict 模式，禁止 `any`
- 优先接口（interface）而非类型别名
- 测试文件与源文件并置：`foo.ts` → `foo.test.ts`
- 所有日期使用 ISO 字符串；API 响应中禁止 Date 对象
```

一个代码示例胜过三段文字说明。

### 4.5 测试（Testing）

```markdown
## 测试

- 框架：Vitest
- 运行：`pnpm test`（全量）或 `pnpm test --filter <pkg>`（单包）
- 新代码要求 >80% 行覆盖率
- 移动文件或修改导入后，运行 `pnpm lint` 确保规则通过
```

### 4.6 Git 工作流（Git Workflow）

```markdown
## Git

- 分支命名：`feat/xxx`、`fix/xxx`、`chore/xxx`
- 提交格式：Conventional Commits
- PR 标题：`[package-name] Description`
- 提交前必须通过 `pnpm lint` 和 `pnpm test`
```

---

## 5. 不要放什么

| ❌ 不要放 | 原因 |
|-----------|------|
| "You are a senior engineer" | 不产生可验证行为，不改变 Agent 输出 |
| "Follow SOLID / write clean code" | 模型已经知道这些，放了等于没放 |
| 完整的技术栈描述 | Agent 可以自己探索 `package.json` |
| 详细的 API 文档 | 链接到 `docs/` 目录 |
| 一次性的任务需求 | 放在任务 prompt 里 |
| 会被 linter/CI 强制执行的规则 | 用工具执行，比文字可靠 |
| 密钥、密码、凭据 | `AGENTS.md` 是普通项目上下文，不是密钥库 |

**判断标准**：这条指令去掉后，Agent 会不会犯错？如果不会，删掉。

---

## 6. 前导词（Leading Words）：用一个词锚定一个行为区域

这是 `writing-for-agents` 技能中最精妙的概念。

**前导词**是模型预训练中已有的紧凑概念（如 _lesson_、_fog of war_、_tracer bullets_），Agent 在执行文档时会反复使用它。它作为 token 重复出现，逐步积累分布式定义，用最少的 token 锚定整个行为区域。

### 在文档体中：执行锚定

Agent 每次看到这个词就联想到同一组行为。例子：

- "fast, deterministic, low-overhead" → **tight**（一个 tight 循环）
- "每次提交前必须通过所有检查" → **gate**（gate 通过才提交）

### 在指针中：调用锚定

当同一个词出现在你的 prompt、文档和代码库中，Agent 会把共享语言和材料关联起来，更可靠地触发。

### 实践方法

假设你发现 Agent 反复在三个地方描述同一件事："测试必须通过、类型检查必须通过、lint 必须通过"。不如用一个词：

> 提交前必须通过 **gate**（`pnpm typecheck && pnpm lint && pnpm test`）

现在 "gate" 就是前导词。你在文档任何地方提到 gate，Agent 都知道是什么。

![前导词：用一个词锚定一片行为——gate 锚定 typecheck+lint+test](/blog/how-to-write-agents-md/leading-words.jpeg)

---

## 7. 剪枝（Pruning）：文档退化的四种死法

### 7.1 重复（Duplication）

同一含义出现在多处 → 维护成本高、token 浪费、含义权重虚高。

**修复**：保持单一真实来源。一个含义只在一个权威位置。

### 7.2 缓存（Cache）

文档重复了环境里已有的信息 → `package.json` 里写什么就别在 `AGENTS.md` 里再写一遍。

**例外**：缓存那些 Agent 无法快速查到的东西——未写明的惯例、选择背后的原因、配置里没说的坑。

### 7.3 不相关（Irrelevance）

每一行都要问：它还和这份文档的目的相关吗？

没有剪枝纪律的默认命运是**沉积**：旧层沉淀下来，因为添加感觉安全，删除感觉有风险，直到你要从中间挖出还活着的内容。

![剪枝：重复、缓存、不相关、空操作——定期重剪](/blog/how-to-write-agents-md/pruning.jpeg)

### 7.4 空操作（No-ops）

一句 Agent 默认就会遵守的指令，说出来就是浪费 token。

**测试**：删掉这句，Agent 的行为会变吗？如果不会，整句删掉。

常见空操作：
- "write clean code" → 模型默认就会
- "be thorough" → 模型会尽力，但换个更强的词（relentless）效果更好
- "follow best practices" → 什么 best practices？

---

## 8. CLAUDE.md 的专属能力

如果你用 Claude Code，`CLAUDE.md` 有几项 `AGENTS.md` 没有的能力：

### @import 语法

```markdown
See @AGENTS.md for base rules.  # 导入共享规则

## Claude 专属
- 使用子代理时，优先用 Task 工具分派
- 允许的工具：Read, Glob, Grep, Edit, Write, Bash
```

### 路径级规则

`.claude/rules/api-rules.md` 只在 Claude 编辑匹配路径的文件时加载，不污染其他任务的上下文。

### 本地覆盖

`CLAUDE.local.md` 加入 `.gitignore`，个人偏好不影响团队。

---

## 9. Monorepo 策略：层级化文件

```text
project/
├── AGENTS.md                    # 全局规则：语言版本、包管理器、提交格式
├── packages/
│   ├── api/
│   │   ├── AGENTS.md            # API 特定规则：Fastify 约定、Prisma 模式
│   │   └── src/
│   └── web/
│       ├── AGENTS.md            # 前端特定规则：React 约定、CSS 方法论
│       └── src/
```

**规则**：最近的 `AGENTS.md` 优先。根文件设基线，子目录文件扩展或覆盖。OpenAI 的 Codex 仓库有 88 个 `AGENTS.md` 文件。

---

## 10. 从零开始的五步流程

### 第 1 步：让 Agent 自己草稿

```bash
# Claude Code
/init

# 其他工具
"Read the codebase and draft an AGENTS.md for this project."
```

输出会太长。没关系，你要剪。

### 第 2 步：对每一行做"删除测试"

> 删掉这行，Agent 会不会犯错？

大多数行通不过测试。删掉。

### 第 3 步：把有时才用到的内容移到技能

只有某些任务才需要的内容（写博客、部署、生成品牌素材）→ 移到 `.claude/skills/` 或独立的 `SKILL.md` 文件。`AGENTS.md` 里留一行指针。

### 第 4 步：观察行为

加了某条规则后，Agent 的行为真的变了吗？如果没变，这条规则没有重量，删掉。

### 第 5 步：定期重剪

每 2-3 个月做一次审计。删除 6 个月没触发过的规则。就像依赖审计一样。

![从零开始的五步流程：让 Agent 草稿 → 删除测试 → 移到技能 → 观察行为 → 定期重剪](/blog/how-to-write-agents-md/five-steps.jpeg)

---

## 11. 一个完整的示例

```markdown
# AGENTS.md

Node 20 + pnpm 9。包管理器：`pnpm`，禁止 `npm` 或 `yarn`。

## 命令

- 安装：`pnpm install --frozen-lockfile`
- 开发：`pnpm dev`
- 单包测试：`pnpm test --filter <pkg>`
- 类型检查：`pnpm typecheck`
- 全量测试：`pnpm test`（约 20 分钟，单包测试通过后再跑）

## 边界

- 禁止编辑 `generated/`；改 schema 后 `pnpm generate`
- 添加生产依赖或改迁移文件前先问
- 不要提交 `.env` 文件；用 `.env.example` 作模板

## 结构

- `src/api/` — API 路由
- `src/core/` — 业务逻辑
- `packages/shared/` — 共享类型，禁止引入框架

## 风格

- TypeScript strict，禁止 `any`
- 测试文件与源文件并置：`foo.ts` → `foo.test.ts`
- API 响应使用信封格式（`packages/shared/src/types/response.ts`）

## 修改前必读

| 区域 | 先读 |
|------|------|
| API 路由 | `packages/api/docs/routing.md` |
| 认证 | `packages/api/docs/auth.md` |
| 前端状态 | `packages/web/docs/state-management.md` |
```

50 行。高信号。没有废话。

---

## 12. 关键要点

1. **AGENTS.md 是运行时指令集**，不是文档——每一行都要产生可观察的行为改变
2. **200 行是上限**，实践中 50-100 行最佳
3. **命令是最高效的一节**：完整命令 + 标志 + 成本（耗时）
4. **三级边界模型**（始终做 / 先问 / 禁止）是经过验证的最有效模式
5. **用代码示例代替散文**：一个示例胜过三段描述
6. **前导词**用一个 token 锚定整个行为区域，比长句更可靠
7. **定期剪枝**：删除过时规则，像维护代码一样维护这份文件
8. **AGENTS.md 是代码**：变更和代码一起提交，走相同的 PR 审查流程

---

## 参考来源

- [Chatcode: AGENTS.md and CLAUDE.md Best Practices](https://chatcode.dev/articles/agents-md-claude-md-best-practices) — 2026
- [Addy Osmani: AGENTS.md — giving agents project context](https://addyosmani.com/agents/15-agents-md/) — 2026
- [GitHub Blog: Analysis of 2,500+ AGENTS.md files](https://github.blog/) — Matt Nigh
- [Anthropic: Claude Code Memory & CLAUDE.md](https://docs.anthropic.com/)
- [AGENTS.md Open Standard](https://agents.md/) — Agentic AI Foundation
- [writing-for-agents skill](https://github.com/) — 信息层次、前导词、剪枝原理
- [self.md: AGENTS.md Concepts](https://self.md/concepts/agents-md/)
- [BuildBetter: AGENTS.md Complete Guide](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/)
