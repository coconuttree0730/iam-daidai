/* 滚动 scrub —— hero 单屏原地融合（2026-09-11 用户裁定）
 *
 * 页面不滚动（hero 单屏、黑条页脚恒定）。纵向滚轮/触摸输入被截获为
 * scrub 进度，人物 canvas 在两套素材间"原地换血"：
 *
 *   pointer 模式（默认）→ hero 121 帧指针跟随（demo-driver）；
 *     触屏手指上滑 / 滚轮向下累计 ≥ ENTER_PX → 切入 scroll 模式
 *     （193 帧线性钳制素材）。
 *     切入瞬间两素材都是"正面静止"姿态且墨迹同尺度同位（f0 对齐校准，
 *     见 index.astro 的 .scroll-figure）→ 观感是素材原地换血，人物没动。
 *   scroll 模式 → 增量直接映射进度（两端钳制）；**方向两套输入各按自己的惯例**：
 *     滚轮向下 = 前进（页面往下滚的直觉），触屏手指上滑 = 前进（推动内容的直觉）。
 *     倒回 f0 → 自动切回 pointer 模式。
 *
 * 与 demo-driver 的互斥：scroll 模式期间在 documentElement 上置
 * data-scrub="on"，demo-driver 的 applyProgress 看到它就冻结 hero 姿态——
 * 指针移动不再驱动（两素材不是连续动作，指针映射此刻无意义）。
 *
 * 加载预算：不做全量预热。构造时的首次 render(0) 会顺带拉取并解码 seg0
 * （366KB），f0 常备；其余 19 段在 scrub 推进时按需取（两层缓存），
 * 越往后段越提前就位——单屏页没有"预热窗口"，按需是唯一合理策略。
 */
import {
  createFrameAnimator,
  createSegmentedSpriteRenderer,
} from './motion.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const readNumber = (value) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/* 版式飞散进度：CSS 侧所有位移都消费这一个变量（--sc，0–1）。
 *
 * 为什么由本模块写、而不是另起一个 scroll-stage.js：
 *   位移必须与人物动作**同源同步**。行程累计 acc、缓动收敛都在这里，
 *   再开一个滚轮监听器会造成两份累计值各自漂移（阈值/钳制/方向各一套），
 *   滚动到边界时人物停了而版式还在走。这里直接复用同一份进度。
 *
 * 为什么写 documentElement 而不是 .stage：
 *   位移元素跨层（.chrome z6 / .fan z7 / .infobar z4 / .title 拆层），
 *   且部分规则在 :global() 与手机档里被覆盖；挂在根元素上是唯一能让
 *   所有后代在任意层叠上下文里都读到同一值的做法。 */
const SC_ROOT = document.documentElement;
const setScatter = (value) => {
  SC_ROOT.style.setProperty('--sc', clamp01(value).toFixed(4));
};

const view = document.querySelector('[data-scrub-view]');

if (view) {
  const sprite = view.querySelector('[data-scrub-sprite]');
  const heroSprite = view.querySelector('[data-sprite]');
  const frameCount = readNumber(view.dataset.scrubCount);
  const cellWidth = readNumber(view.dataset.scrubCellWidth);
  const cellHeight = readNumber(view.dataset.scrubCellHeight);
  let segments = null;
  try {
    segments = JSON.parse(view.dataset.scrubSegments ?? '');
  } catch {
    segments = null;
  }

  if (sprite && heroSprite && frameCount && cellWidth && cellHeight && segments) {
    /* 手感参数：ENTER_PX = 进入阈值（防误触）；RANGE_PX = 满行程的累计纵向位移。
       ★ 2026-09-12 用户实测"鼠标滑动一下就到底了" → 桌面端行程太短，改为
         **按输入设备自适应**（用户两种设备都用，静态 matchMedia 判不出来）。

       为什么不能静态判断：`matchMedia('(pointer: coarse)')` 只区分**触摸屏**，
       触摸板在浏览器看来仍是 `pointer: fine` —— 两者都走桌面分支，但
       deltaY 量级差一个数量级：
         鼠标滚轮：离散大值，一格 ≈ 100px（且常带 100 的整数倍特征）
         触摸板：  连续小值，一次 ≈ 1–10px，快划也就几十
       2400px 在滚轮上是 24 格（偏少），在触摸板上几十次滚动就滑完 → "一下到底"。

       自适应策略：按**最近一次 deltaY 的量级**切换档位，带**迟滞**防抖动。
         首次输入定档；之后只有连续偏离当前档位足够多次才切换。
       手机（coarse）仍走原来的"一次自然滑动"标定，不受影响。 */
    const ENTER_PX = 30;
    const coarse =
      typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

    const MOBILE_RANGE = Math.max(460, Math.min(900, Math.round(window.innerHeight * 0.7)));
    /* 桌面两档：滚轮需要"多滚几下"才走完；触摸板需要"多划几屏"。
       滚轮 2400px ≈ 24 格（用户反馈太少）→ 提到 5200 ≈ 52 格，接近两屏滚轮。
       触摸板取视口高的 ~6 倍（一次自然划动 ≈ 0.25 视图高 → 约 24 次划完 193 帧）。 */
    const WHEEL_RANGE = 5200;
    const TRACKPAD_RANGE = Math.max(3600, Math.round(window.innerHeight * 6));

    let range = coarse ? MOBILE_RANGE : WHEEL_RANGE;
    /* 累计纵向输入（px），钳制在 [0, range]。声明必须在 noteDelta 之前：
       切档时要按比例映射 acc，提前声明避免 TDZ 陷阱。 */
    let acc = 0;
    /* 迟滞计数器：连续 N 次落在另一档才切，避免滚轮逐格间隙被误判成触摸板。
       ⚠️ 计数语义是"连续偏离当前档"，不是"连续命中某档"：
       中间只要回到 lastKind 一次就清零。两档交替时永远不会切（保守，防抖）。 */
    const SWITCH_STREAK = 3;
    let streak = 0;
    let lastKind = null;

    const noteDelta = (absDelta) => {
      if (coarse) return;
      /* 量级判据：滚轮单次几乎必 ≥ 40px；触摸板单次通常 < 20px。
         40 这条线落在两档之间，且滚轮的 100 整数倍绝不会踩到触摸板侧。 */
      const kind = absDelta >= 40 ? 'wheel' : 'trackpad';
      if (kind === lastKind) {
        streak = 0;
      } else {
        streak += 1;
        if (streak >= SWITCH_STREAK) {
          lastKind = kind;
          streak = 0;
          const next = kind === 'wheel' ? WHEEL_RANGE : TRACKPAD_RANGE;
          if (next !== range) {
            /* 切档时按比例保住当前进度：否则同一 acc 在新分母下会跳变。 */
            const p = range > 0 ? acc / range : 0;
            range = next;
            acc = p * range;
          }
        }
      }
    };

    const renderer = createSegmentedSpriteRenderer({
      target: sprite,
      segments,
      frameCount,
      cellWidth,
      cellHeight,
      wrap: false, // 叙事时间轴：钳制停帧，首尾不相接
      autoPreload: false, // 单屏页无预热窗口，按需取段
    });

    let active = false;

    const setActive = (on) => {
      active = on;
      if (on) {
        document.documentElement.dataset.scrub = 'on';
        sprite.hidden = false;
        heroSprite.hidden = true;
      } else {
        delete document.documentElement.dataset.scrub;
        sprite.hidden = true;
        heroSprite.hidden = false;
        acc = 0;
        /* 交还 hero 时版式必须归位：这里直接清到 0，而不是等 animator 的
           render 回调——回调只在帧号变化时触发，越过阈值即归零的情形下
           帧号恒为 0，回调不会来，版式会永久停在飞散态。 */
        setScatter(0);
      }
    };

    const animator = createFrameAnimator({
      frameCount,
      wrap: false,
      /* ── maxSpeed：已回退到默认（2026-09-12 用户裁定"要流畅的交互"）────
       * 曾试过 ×0.8（降速求连续）→ 满行程从 1.35s 拖到 2.19s，缓动尾部变长、
       * 手感"发黏"，用户否掉。**真正的病根不是 maxSpeed，是 RANGE_PX 太短**
       * （2400px 在触摸板上几下就滑完 → "滑动一下就到底"）。行程拉长后
       * 每格滚动对应的帧数变少，maxSpeed 默认值（frameCount×2）不再撞上限，
       * 跳帧自然缓解。故此处显式写回默认，保留注释说明来龙去脉。 */
      maxSpeed: frameCount * 2,
      render: (frame) => {
        renderer.render(frame);
        /* 版式飞散跟**缓动后的帧进度**而不是原始行程：这样人物动作与版式
           位移共用同一条 smoothDamp 曲线，不会一个跟手、一个带延迟。
           归一化用 frameCount − 1（末帧 = 1），与 animator 的取帧口径一致。 */
        setScatter(frameCount > 1 ? frame / (frameCount - 1) : 0);
        /* 倒回 f0（且输入已回到起点）→ 交还 hero 指针跟随。
           f0 与 hero rest 对齐，切换无跳变。 */
        if (active && acc <= 0 && frame === 0) setActive(false);
      },
    });

    function input(delta) {
      if (!active) {
        /* 只累计向下：在 rest 姿态向上滚没有可倒退的内容 */
        acc = Math.max(0, acc + delta);
        if (acc < ENTER_PX) return;
        setActive(true);
        acc -= ENTER_PX; // 越过阈值的部分立刻生效
      } else {
        acc = Math.max(0, Math.min(range, acc + delta));
        /* 边界：上提回到起点、且动画已归位到 f0 → 交还 hero。
           为什么不能只靠 animator 的 render 回调：回调只在**帧号变化**时触发，
           若激活后帧号一直是 0（越过阈值即归零的情形），回调永远不会来，
           状态机会卡在 scroll 模式，hero 画布再也回不来。 */
        if (delta < 0 && acc <= 0 && Math.round(animator.getCurrentFrame()) === 0) {
          setActive(false);
          return;
        }
      }
      animator.setProgress(acc / range);
    }

    /* ── 程序化推进会：站内入口把 scrub 推到收尾态（2026-09-13 用户裁定）──
     * 用途：基本信息抽屉里的「邮箱」图标不再跳独立页，改为直接露出首页底部的
     * 联系表单。表单属于收尾区块（--sc→1 才升起），所以这里把行程一次推到满。
     *
     * 为什么走自定义事件，而不是导出函数 / 挂 window 全局：
     *   调用方（BasicDrawer 的 <script>）与本模块是两个独立模块，事件是唯一
     *   既不污染全局命名空间、又不需要构建期互相 import 的握手方式；
     *   页面若没有 scrub 舞台，事件自然落空，调用方无须判空。
     *
     * 复用与滚轮**完全相同的状态机**（acc / setActive / animator.setProgress），
     * 人物时间轴与版式飞散因此仍由同一份缓动驱动——不新开第二份进度（单一
     * 进度是文件头注的硬契约，避免两套累计值漂移）。 */
    const toOutro = () => {
      acc = range;
      if (!active) setActive(true);
      animator.setProgress(1);
    };
    document.addEventListener('scrub:outro', toOutro);

    /* ── 程序化归零：把时间轴与版式送回 home 初态（2026-09-13）──────────
     * 用途：首页的「回到顶部」——右侧回顶绳（TopRope.astro）与右下悬浮栈的
     * ▲ 都派发这个事件。**为什么不是 window.scrollTo**：首页根本不滚动，
     * 纵向输入全被本模块吃成时间轴，所以"回到顶部"在语义上就是"把 acc 归零
     * 并把画面送回 f0"。
     *
     * 与 toOutro 对称：同样复用 acc / setActive / animator.setProgress 这**唯一
     * 一份状态机**——不新开第二份进度（文件头注的硬契约）。
     * acc 归零后动画缓动回 f0，归零那一刻 render 回调里的
     * `active && acc <= 0 && frame === 0` 分支把控制权交还 hero 指针跟随，
     * setActive(false) 内同时把 --sc 清到 0，飞散的版式因此整体归位。
     */
    const toTop = () => {
      acc = 0;
      animator.setProgress(0);
      /* 兜底：render 回调只在**帧号变化**时触发——若人物此刻已在 f0
       * （刚激活未推进就点了归零），回调永远不会来，状态机会卡在 scroll 模式，
       * hero 画布再也回不来。setActive(false) 里那句"必须显式归零位移"的注释
       * 记的是同一类坑。 */
      if (Math.round(animator.getCurrentFrame()) === 0) setActive(false);
    };
    document.addEventListener('scrub:top', toTop);

    /* 初始归零：--sc 是挂在 :root 上的内联自定义属性，跨路由导航（首页 →
       作品集 → 返回）时浏览器会保留它，不显式清一次会带着上次的飞散态入场。 */
    setScatter(0);

    /* ── 语言切换原位恢复（2026-09-14 用户裁定）────────────────────────
     * 诉求：在底部（或任意 scrub 进度）点页头「EN/中」切换语言，新页面要
     * 停在**当前位置**，而不是回到顶部重放。首页不滚动——纵向输入全被本
     * 模块吃成时间轴进度，所以「位置」不能用 scrollY 表达，必须持久化
     * scrub 进度本身（内页的 scrollY 恢复走 Base.astro 的另一把钥匙，
     * 两把钥匙互不干扰）。
     *
     * 写入：capture 阶段监听全文档点击，命中语言切换链（a.lang）时把当前
     * **归一化进度** acc/range 存进 sessionStorage。用 capture 而非冒泡：
     * 不依赖链接内部结构，也赶在浏览器导航离页前落盘。存归一化值而非 acc
     * 像素——range 按输入设备自适应（滚轮/触摸板两档），恢复时要用新页面
     * 的 range 重新折算。
     * 读取：初始化时发现钥匙即消费（一次性握手，读后立删）：按当前 range
     * 折算回 acc、setActive(true) 换上 scrub 素材，再 animator.snap 到位。
     * 必须用 snap 而非 setProgress：后者从 f0 缓动过去，整条时间轴快进
     * 一遍——正是用户否掉的「回到顶部」观感的变体。snap 触发的 render 回调
     * 会同步写 --sc，HeroStage 的 MutationObserver 随即置 data-outro 标记，
     * 收尾区（表单/语录）的指针交互在恢复到位后立即可用。
     * 进度为 0（还在 hero 指针跟随态）时不存不恢复：新页面默认就是该态。 */
    const LANG_SCRUB_KEY = 'langswitch:scrub';
    document.addEventListener(
      'click',
      (event) => {
        const t = event.target;
        if (!(t instanceof Element) || !t.closest('a.lang')) return;
        try {
          sessionStorage.setItem(
            LANG_SCRUB_KEY,
            (range > 0 ? acc / range : 0).toFixed(4)
          );
        } catch {}
      },
      true
    );
    try {
      const stored = Number.parseFloat(
        sessionStorage.getItem(LANG_SCRUB_KEY) ?? ''
      );
      sessionStorage.removeItem(LANG_SCRUB_KEY);
      if (Number.isFinite(stored) && stored > 0) {
        const p = clamp01(stored);
        acc = p * range;
        if (!active) setActive(true);
        animator.snap(p);
      }
    } catch {}

    /* 滚轮：line 模式（Firefox）按 ~40px/格 归一。passive:false 以便在
       scrub 生效期间阻止页面滚动（矮视口下 hero min-height 会产生滚动条）。 */
    window.addEventListener(
      'wheel',
      (event) => {
        /* 档案抽屉（#basic dialog）打开期间让位：不累计、不 preventDefault，
           让滚轮去滚 overlay 自己的内容（2026-09-13，data-file-open 由
           BasicDrawer 开关抽屉时写在 :root 上） */
        if (document.documentElement.dataset.fileOpen !== undefined) return;
        const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        if (!delta) return;
        noteDelta(Math.abs(delta)); // 先按量级自适应档位，再累计
        if (active || acc > 0) event.preventDefault();
        input(delta);
      },
      { passive: false }
    );

    /* ── 触摸：单指纵向拖动（2026-09-11 移动端适配，方向 2026-09-11 深夜修正）──
       **方向按手机惯例：手指上滑（由下往上）= 内容前进，下滑 = 倒退。**
       与滚轮相反（滚轮向下 = 前进，那是"页面往下滚"的直觉）——手机上是
       "手指推动内容"的直觉，向下拖 = 内容回退。用户实测反馈当前方向反了，
       故这里对触屏取负号：dy<0（上滑）→ input 收正数 → 帧序前进。
       手势归属的三条规则：
       1. 轴向判定——首次位移超过 6px 时定轴：|dy| ≥ |dx| 判纵向（归 scrub），
          否则判横向并整段放行（把返回手势等留给浏览器，不抢）。
       2. 纵向一旦成立就 preventDefault，页面不滚、不回弹；
          除此之外的防线是 CSS 的 .stage{touch-action:none}（硬保证）。
       3. 不拦 pointer 事件——点卡定格、触他归位等既有触摸语义全部保留：
          tap（无位移）不产生有效累计，照样走 hero 的触摸契约。 */
    const AXIS_LOCK_PX = 6;
    let touchStart = null; // { x, y }
    let touchAxis = null; // 'v' | 'h' | null（未定轴）
    let lastTouchY = null;

    const resetTouch = () => {
      touchStart = null;
      touchAxis = null;
      lastTouchY = null;
    };

    window.addEventListener(
      'touchstart',
      (event) => {
        /* 抽屉打开期间：触摸手势全部让位给 overlay（sheet 滚动、点链接） */
        if (document.documentElement.dataset.fileOpen !== undefined) return resetTouch();
        if (event.touches.length !== 1) return resetTouch();
        const t = event.touches[0];
        touchStart = { x: t.clientX, y: t.clientY };
        touchAxis = null;
        lastTouchY = t.clientY;
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (event) => {
        /* 抽屉打开期间让位：既不消费位移也不 preventDefault，sheet 才能滚 */
        if (document.documentElement.dataset.fileOpen !== undefined) return;
        if (lastTouchY == null || event.touches.length !== 1) return;
        const t = event.touches[0];
        const y = t.clientY;
        if (!touchAxis && touchStart) {
          const dx = Math.abs(t.clientX - touchStart.x);
          const dy = Math.abs(y - touchStart.y);
          if (dx > AXIS_LOCK_PX || dy > AXIS_LOCK_PX) touchAxis = dy >= dx ? 'v' : 'h';
        }
        if (touchAxis === 'h') {
          lastTouchY = y; // 横向手势：只跟位置，不消费位移
          return;
        }
        if (touchAxis === 'v') event.preventDefault();
        const dy = y - lastTouchY; // 手指位移：下正、上负
        lastTouchY = y;
        if (!dy) return;
        input(-dy); // 上滑（dy<0）= 前进
      },
      { passive: false }
    );
    window.addEventListener('touchend', resetTouch);
    window.addEventListener('touchcancel', resetTouch);
  } else {
    console.warn('[scrub] data-scrub-view 属性不完整，滚动 scrub 未启用：', view);
  }
}
