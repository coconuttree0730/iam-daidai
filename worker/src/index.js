/* ── 联系表单投递 Worker ───────────────────────────────────────────
 *
 * 链路：POST daidai.click/api/contact（Workers Route 同源接入，无 CORS）
 *       → 校验 → env.EMAIL.send()（send_email binding）→ 直发站长邮箱。
 *       访客邮箱放 Reply-To：站长直接点「回复」即回访客。
 *
 * 设计取向：
 * - 零第三方、零 API 密钥：binding 由 wrangler.jsonc 的 send_email 段声明。
 * - 纵深防御写进绑定层：allowed_destination_addresses 把收件人硬限制为
 *   站长邮箱——即使代码被滥用，信也只能到你自己邮箱。
 * - 反垃圾是无状态粗筛（Origin + honeypot + 最短停留），挡无差别脚本；
 *   真被刷再加 Cloudflare Turnstile（免费，Worker 里 siteverify 校验）。
 * - honeypot / 秒提交返回假成功（ok:true）——让 bot 以为得手，
 *   不暴露判定逻辑。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const respond = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return respond({ ok: false, error: 'method_not_allowed' }, 405);
    }

    /* 同源粗筛：浏览器发起的 POST 必带 Origin 头；非白名单 403。
     * 只挡跨站网页调用，不是决心攻击者的对手——后者靠绑定层收件人
     * 白名单兜底（最坏结果 = 给站长自己发垃圾邮件）。 */
    const allowed = (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get('origin') ?? '';
    if (!allowed.includes(origin)) {
      return respond({ ok: false, error: 'forbidden' }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ ok: false, error: 'bad_json' }, 400);
    }

    /* honeypot：人类不可见不可填的陷阱字段。命中 → 假成功，不投递。 */
    if (typeof body._gotcha === 'string' && body._gotcha.trim() !== '') {
      return respond({ ok: true });
    }

    /* 最短停留：_elapsed 由前端从页面加载计到提交（毫秒）。
     * 真实人类从打开页面到滚到收尾区提交必然 >3s。 */
    if (typeof body._elapsed !== 'number' || body._elapsed < 3000) {
      return respond({ ok: true });
    }

    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();
    const message = String(body.message ?? '').trim();
    const page = String(body._page ?? '').slice(0, 300);

    if (!name || name.length > 100) {
      return respond({ ok: false, error: 'invalid_name' }, 400);
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return respond({ ok: false, error: 'invalid_email' }, 400);
    }
    if (!message || message.length > 5000) {
      return respond({ ok: false, error: 'invalid_message' }, 400);
    }
    /* 同意勾选：前端 required 已拦人机交互，这里拦 API 直刷——
       无同意的数据不进入投递链（个人信息处理的合法性边界在服务端）。 */
    if (body.consent !== true) {
      return respond({ ok: false, error: 'consent_required' }, 400);
    }

    const submittedAt = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });
    const text = [
      `姓名 / Name: ${name}`,
      `邮箱 / Email: ${email}`,
      '',
      message,
      '',
      '────────────────────',
      `提交时间：${submittedAt}`,
      `来源页面：${page || '（未知）'}`,
    ].join('\n');

    try {
      await env.EMAIL.send({
        to: env.TO_EMAIL,
        from: { email: env.FROM_EMAIL, name: 'Daidai Archive' },
        replyTo: email,
        subject: env.SUBJECT,
        text,
      });
      return respond({ ok: true });
    } catch (err) {
      console.error('send_email failed:', err?.code, err?.message);
      const status =
        err?.code === 'E_RATE_LIMIT_EXCEEDED' || err?.code === 'E_DAILY_LIMIT_EXCEEDED'
          ? 429
          : 502;
      return respond({ ok: false, error: 'send_failed' }, status);
    }
  },
};
