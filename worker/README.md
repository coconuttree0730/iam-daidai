# 联系表单投递 Worker

> 链路一句话：网页表单（`data-endpoint="/api/contact"`，同源）→ Workers Route
> `daidai.click/api/*` → 本 Worker → `send_email` binding **直发**站长邮箱
> `hello@daidai.click`（访客邮箱在 Reply-To，点回复即回访客）。
> 全程 Cloudflare 原生能力，零第三方邮件服务、零 API 密钥。
>
> 关键裁定（2026-09-12）：**网页上不出现明文真实邮箱**——对外展示与 mailto
> 一律用域名地址 `hello@daidai.click`（Email Routing 转发）；真实收件邮箱
> 只存在于本目录 `wrangler.jsonc`。

## 首次部署（4 步，动作在 Cloudflare 侧，一次配好基本不再动）

1. **登录**：`npx wrangler login`（浏览器授权一次）。

2. **域名 onboard Email Service**（出站发信的前提，SPF/DKIM/DMARC 自动写入）：

   ```bash
   npx wrangler email sending enable daidai.click
   ```

   或 Dashboard → Email Service → Email Sending → Onboard Domain → 选
   `daidai.click`。等 DNS 记录生效（通常几分钟内）。

3. **部署 Worker**（`wrangler.jsonc` 里已写好 routes，deploy 时自动挂
   `daidai.click/api/*`，无需 Dashboard 手动配 Route）：

   ```bash
   cd worker && npx wrangler deploy
   ```

4. **开 Email Routing**（入站转发，让 `hello@daidai.click` 可收信）：
   Dashboard → `daidai.click` → Email → Email Routing → 启用，添加地址规则
   `hello@daidai.click` → `hello@daidai.click`，foxmail 会收到
   Cloudflare 验证邮件，点确认即生效。

## 验证

浏览器打开 `https://daidai.click`，滚到收尾区块，填表提交：

- 状态行「已发送」→ foxmail 收到信：from `no-reply@daidai.click`，
  Reply-To = 访客邮箱，正文含三字段 + 提交时间 + 来源页。
- 若显示「发送失败」→ 多半是步骤 2/3 未完成或 DNS 未生效，稍等重试。

## 本地联测

```bash
cd worker && npx wrangler dev        # :8787，EMAIL binding 为本地模拟，不真发信
npm run dev -- --port 8888           # 另开一个终端
```

临时把 `src/components/HeroStage.astro` 的 `data-endpoint` 改为
`http://localhost:8787/api/contact`（白名单已含 4321/8888），测完改回相对路径。

## 常改项

| 要改什么 | 改哪里 | 生效方式 |
|---|---|---|
| 收件邮箱 | `wrangler.jsonc` 的 `vars.TO_EMAIL` **和** `send_email[].allowed_destination_addresses`（两处必须同步） | `npx wrangler deploy` |
| 邮件主题 / 发件地址 | `wrangler.jsonc` 的 `vars` | `npx wrangler deploy` |
| 表单文案（标题/占位符/按钮） | `src/data/profile.json` | `git push`（Pages 自动部署） |
| Worker 逻辑 | `worker/src/index.js` | `npx wrangler deploy` |

**部署边界**：Worker 不在 Pages 的 git 自动构建链路里——改 Worker 必须手动
`npx wrangler deploy`；改前端照常只 `git push`。

## 安全边界（诚实说明）

- Origin 校验 + honeypot + 最短停留都是**无状态粗筛**，挡的是无差别脚本，
  不是决心攻击者（Origin 可被非浏览器客户端伪造）。
- 最坏情况的兜底在绑定层：`allowed_destination_addresses` 保证这封信
  只能到站长邮箱——被滥用的上限 = 给自己发垃圾邮件。
- 真被刷时再加 Cloudflare Turnstile（免费）：前端取 token，Worker 里
  siteverify 校验，改动集中在 `index.js` 一处。
