/* 立绘清晰度受控 A/B：同一帧、同一视口，只改 --figure-h。
 *
 * 为什么需要它：浏览器截图与无头渲染的指针状态不同 → 雪碧图落在不同帧，
 * 直接拿两张图对比会混淆"帧不同"与"分辨率不同"。这里在同一页面实例上
 * 只改一个 CSS 变量，其余全部不变，排除帧差异。
 *
 * 用法： CDP_PORT=9347 node qa/ab-figure.mjs <URL> <W> <H> <oldFigureH>
 * 产出： qa/out/ab-figure-<new>.png / qa/out/ab-figure-<old>.png
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2];
const W = Number(process.argv[3]);
const H = Number(process.argv[4]);
const OLD = process.argv[5] ?? '910px';
const PORT = process.env.CDP_PORT ?? '9347';
mkdirSync('qa/out', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
const connect = (ws) => (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', h);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

const t = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const send = connect(ws);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL_ });
await sleep(3000);

const shoot = async (tag) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`qa/out/ab-figure-${tag}.png`, Buffer.from(r.data, 'base64'));
  const m = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const f = document.querySelector('.hero-figure').getBoundingClientRect();
      return { y: +f.y.toFixed(1), h: +f.height.toFixed(1) }; })()`,
  });
  console.log(`${tag}: figure y=${m.result.value.y} h=${m.result.value.h}`);
  return m.result.value;
};

const neu = await shoot('new');
await send('Runtime.evaluate', {
  expression: `document.querySelector('.stage').style.setProperty('--figure-h', '${OLD}')`,
});
await sleep(600);
const old = await shoot('old');

console.log(JSON.stringify({ neu, old, ratio: +(old.h / neu.h).toFixed(4) }));
ws.close();
