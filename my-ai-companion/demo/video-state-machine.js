// @ts-check
/**
 * 无缝视频状态机组件（VideoStateMachine）。
 *
 * 把页面中央/右侧的角色从"静态图"升级为"真人循环视频"，并支持在多个
 * 动作素材间无缝切换。
 *
 * ── 三次轨道架构（解决切换闪黑）────────────────────────────────────────
 * 旧实现用两个视频轨道，切换时在 apply 回调里"同步"把下一段预缓冲到刚被
 * 移除 .active、但 CSS 淡出（0.4s）还没走完的旧轨道上：旧轨道此刻 opacity
 * 仍≈1，一改 src + load() 就瞬间刷成黑帧，于是出现"一闪而过的黑屏"。
 *
 * 本实现改为三轨道（E0 / E1 / E2）轮转：
 *   - `_active`：当前显示（.active，opacity:1）的轨道；
 *   - `_pre`：已把"下一段"预解码、暂停在首帧的轨道（候选过渡目标）；
 *   - 第三个轨道：始终完全隐藏（早已淡出），作为预缓冲的专用落点。
 * 关键约束：预缓冲永远只写"第三个轨道"，绝不碰正在显示或正在淡出的轨道，
 * 因此任何时刻被改 src 的轨道都是完全透明的，不可能露出黑帧。
 *
 * 待机（idle）多段序列循环：
 *   - 每播完一段（还剩 IDLE_ADVANCE_AHEAD 秒，timeupdate 提前触发，ended 兜底）
 *     就切到下一段；切换时新段已预缓冲完毕、直接起播，旧段仍保留真实画面，
 *     前台只是 opacity 交叉淡入淡出，全程无黑屏、无跳变。
 *
 * 状态约定（由 main.js 的 setState 映射后调用 switchState）：
 *   - 'idle'     待机 / 默认（可为一组视频的顺序循环）
 *   - 'thinking' 思考中（等待 LLM 响应）
 *   - 'speaking' AI 说话中（TTS 播放）
 *
 * @typedef {'idle' | 'thinking' | 'speaking'} VsmState
 */

/** 待机序列提前切换的剩余时间（秒）。
 * 在某段视频还剩这么多秒时就开始淡入下一段，避免等视频真正 ended。
 * 原因：部分浏览器在视频 ended 的一瞬间会把画面刷成黑帧，若等到那时
 * 再切换，就会出现"一闪而过的黑屏"。提前一点切换，旧轨道还剩真实画面，
 * 新轨道已预缓冲完毕，全程无黑屏、无跳变。 */
const IDLE_ADVANCE_AHEAD = 0.3;

/**
 * 视频状态机。构造后默认播放 idle。
 */
export class VideoStateMachine {
  /**
   * @param {HTMLElement} container 放置三个 <video> 的容器（建议已定位、固定尺寸）
   * @param {Record<VsmState, string>} srcs 各状态对应的视频地址（相对容器所在目录）
   * @param {string[]} [idleVideos] 待机序列：按顺序无缝循环播放的多段待机视频地址
   */
  constructor(container, srcs, idleVideos = []) {
    /** @type {HTMLElement} */
    this._container = container;
    /** @type {Record<VsmState, string>} */
    this._srcs = srcs;
    /** @type {string[]} 待机序列：按顺序循环的多段视频 */
    this._idleVideos = idleVideos;
    /** @type {number} 当前待机序列的播放下标 */
    this._idleIdx = 0;
    /** @type {(() => void) | undefined} 当前轨道播放结束的回调（仅待机序列使用） */
    this._onEnded = undefined;
    /** @type {((e: Event) => void) | undefined} 当前轨道"临近播完"的时间监听（仅待机序列使用） */
    this._onTimeupdate = undefined;
    /** @type {HTMLVideoElement[]} 三轨道 E0 / E1 / E2 */
    this._vids = [this._makeVideo(), this._makeVideo(), this._makeVideo()];
    /** @type {number} 当前显示的轨道下标（0 / 1 / 2） */
    this._active = 0;
    /** @type {number} 已预缓冲"下一段"的轨道下标；-1 表示暂无 */
    this._pre = -1;
    /** @type {VsmState | null} 当前状态 */
    this._state = null;

    // 将三个轨道放入容器，默认显示 E0
    for (const v of this._vids) this._container.appendChild(v);
    this._vids[0].classList.add("active");

    // 默认进入待机
    this.switchState("idle");
  }

  /** 创建一个默认配置的 <video> 轨道。 */
  _makeVideo() {
    const v = /** @type {HTMLVideoElement} */ (document.createElement("video"));
    v.muted = true; // 三路视频均静音，声音由 TTS 播放，避免冲突
    v.loop = true; // 思考/说话默认循环播放；待机序列会临时关闭以触发 ended
    v.playsInline = true; // iOS 内联播放，不加全屏遮罩
    v.autoplay = true;
    v.preload = "auto";
    v.draggable = false;
    v.className = "vsm-video";
    return v;
  }

  /**
   * 确保当前显示（.active）的轨道正在播放。
   * 某些浏览器的自动播放策略（如 Edge）可能把 muted 视频也暂停，
   * 导致角色停在黑屏/未播放状态。在用户首次点击页面时调用它来恢复播放。
   */
  ensurePlaying() {
    const cur = this._vids[this._active];
    if (cur && cur.paused) cur.play().catch(() => {});
  }

  /**
   * 无缝切换到目标状态。
   * @param {VsmState} newState
   */
  switchState(newState) {
    if (newState === this._state) return; // 状态未变，忽略重复调用
    this._state = newState;

    if (newState === "idle") {
      // 待机：播放一整段待机序列（多段无缝顺序循环）
      this._startIdleLoop();
    } else {
      // 思考/说话：停止待机序列，播放单个（循环）视频
      const prevActive = this._active; // 记录即将淡出的旧轨道，预缓冲时避开它
      this._stopIdleLoop();
      const src = this._srcs[newState];
      if (src) this._switchTo(src, true);
      // 预缓冲待机首段到"完全隐藏"轨道，保证从思考/说话回到待机时零黑屏
      if (this._idleVideos.length) this._prebuffer(this._idleVideos[0], prevActive);
    }
  }

  /** 启动待机序列循环：从第 0 段开始播放。
   * 首段也走 _switchTo：若离开待机时已预缓冲好的 idleVideos[0] 在 _pre 轨道上，
   * 就复用该轨道做交叉淡入淡出，避免"直接重载当前显示轨道"造成的闪黑。 */
  _startIdleLoop() {
    if (!this._idleVideos.length) {
      // 未配置待机序列时，回退到单个 idle 视频
      const src = this._srcs.idle;
      if (src) this._switchTo(src, true);
      return;
    }
    this._idleIdx = 1; // 第一段已被消费
    const first = this._idleVideos[0];
    const next = this._idleVideos[1 % this._idleVideos.length];
    this._switchTo(first, false, () => this._playIdleVideo(), next);
  }

  /** 停止待机序列（离开待机状态时调用），移除待机相关监听。 */
  _stopIdleLoop() {
    this._idleIdx = 0;
    this._clearIdleListeners();
  }

  /** 移除所有轨道上的待机结束/临近结束监听。 */
  _clearIdleListeners() {
    for (const v of this._vids) {
      v.removeEventListener("ended", this._onEnded);
      v.removeEventListener("timeupdate", this._onTimeupdate);
    }
    this._onEnded = undefined;
    this._onTimeupdate = undefined;
  }

  /** 播放待机序列中的当前段，并安排播完前无缝切到下一段。
   * 下一段在上一轮已预缓冲到 _pre 轨道，切换时直接复用、零黑屏。 */
  _playIdleVideo() {
    const len = this._idleVideos.length;
    const curSrc = this._idleVideos[this._idleIdx % len];
    const nextSrc = this._idleVideos[(this._idleIdx + 1) % len];
    this._idleIdx++;
    this._switchTo(curSrc, false, () => this._playIdleVideo(), nextSrc);
  }

  /**
   * 把目标视频显示到目标轨道并淡入。优先复用"_pre 轨道"（已预缓冲、已解码、
   * 停在首帧），否则用空闲隐藏轨道现加载。切换完成后把"下一段"预缓冲到
   * 完全隐藏的轨道（绝不碰刚淡出的旧轨道，杜绝闪黑）。
   * @param {string} src 目标视频地址
   * @param {boolean} loop 是否循环。思考/说话循环；待机序列不循环，靠提前切换推进
   * @param {(() => void) | undefined} [onEnded] 待机序列：本段即将播完时切到下一段的回调
   * @param {string} [prebufferSrc] 待机序列：要预缓冲到隐藏轨道的"下一段"视频地址
   */
  _switchTo(src, loop, onEnded, prebufferSrc) {
    const oldActive = this._active;

    // 先移除两个轨道上旧的结束/临近结束监听，避免残留回调重复触发
    this._clearIdleListeners();
    this._onEnded = onEnded;
    this._onTimeupdate = undefined;

    // 1) 决定目标轨道
    let target;
    if (
      this._pre >= 0 &&
      this._vids[this._pre].src.endsWith(src) &&
      this._vids[this._pre].readyState >= 2
    ) {
      // 复用已预缓冲轨道：已解码、停在首帧，直接起播，消除解码黑屏
      target = this._pre;
    } else {
      // 现加载到"既非当前显示、也非 _pre"的完全隐藏轨道，绝不碰正在显示的旧轨道
      target = this._pickFree([this._active, this._pre]);
      this._vids[target].loop = loop;
      if (!this._vids[target].src.endsWith(src)) this._vids[target].src = src;
    }
    this._pre = -1; // 预缓冲槽位已被消费

    const show = () => {
      this._vids[target].removeEventListener("loadeddata", show);
      this._vids[target].play().catch(() => {});
      // 关键：新画面"真正绘制一帧"后才切换，避免旧画面还没撤走、新画面还是黑帧
      this._whenPainted(this._vids[target], () => {
        // 硬切：临时禁用两个轨道的 opacity 过渡，让新旧轨道的透明度瞬间到位。
        // 若保留 CSS 的 transition: opacity 0.4s，新轨道会从 0 淡入到 1，
        // 这段半透明叠加会让深色背景透出，角色看起来"亮度变暗"。
        // 角色序列各段画面高度一致，硬切肉眼几乎无感，且彻底消除亮度变暗。
        const t = this._vids[target];
        const o = this._vids[oldActive];
        t.style.transition = "none";
        o.style.transition = "none";
        t.classList.add("active");
        o.classList.remove("active");
        void t.offsetWidth; // 强制 reflow，让 opacity 立即生效（跳过过渡）
        t.style.transition = ""; // 新轨道已是 opacity:1，恢复过渡无副作用
        o.style.transition = "none"; // 旧轨道保持瞬时隐藏，不再残留 0.4s 淡出过程
        this._active = target;
        // 待机序列：在旧轨道真正"播完闪黑"之前提前切到下一段
        if (this._onEnded) this._armIdleAdvance(t);
        // 预缓冲"下一段"到完全隐藏轨道（排除新显示与刚淡出的旧轨道）
        if (prebufferSrc) this._prebuffer(prebufferSrc, oldActive);
      });
    };

    if (this._vids[target].readyState >= 2) show();
    else this._vids[target].addEventListener("loadeddata", show);
  }

  /**
   * 等视频"真正绘制了一帧"后再执行 done。确认新画面已实际出现在屏幕上才淡入，
   * 避免"旧视频已淡出、新视频还没画出画面"造成的闪黑。
   * 优先用 requestVideoFrameCallback（帧级精确）；不支持时退化为双 rAF；
   * 另有 300ms 兜底，防止 play() 被自动播放策略拦截导致画面一直不出现。
   * @param {HTMLVideoElement} video @param {() => void} done */
  _whenPainted(video, done) {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; done(); };
    const viaFrame = () => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(finish);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
    };
    if (video.readyState >= 2) viaFrame();
    else video.addEventListener("loadeddata", viaFrame, { once: true });
    setTimeout(finish, 300); // 兜底：无论如何在 300ms 内完成切换
  }

  /**
   * 待机序列推进：在视频还剩 IDLE_ADVANCE_AHEAD 秒时提前触发切换（用 ended 兜底）。
   * 关键：提前切换时旧轨道仍显示真实画面，加上新轨道已预缓冲完毕，
   * 可彻底避免"视频播完瞬间闪黑帧"的问题。
   * @param {HTMLVideoElement} video 正在播放的待机视频
   */
  _armIdleAdvance(video) {
    const onTime = () => {
      if (video.duration && video.currentTime >= video.duration - IDLE_ADVANCE_AHEAD) {
        video.removeEventListener("timeupdate", onTime);
        video.removeEventListener("ended", onEnded);
        this._onTimeupdate = undefined;
        this._onEnded(); // 切到下一段
      }
    };
    const onEnded = () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
      this._onTimeupdate = undefined;
      this._onEnded(); // 兜底：无论如何都推进到下一段
    };
    this._onTimeupdate = onTime;
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
  }

  /**
   * 需一并排除的下标集合中，挑一个未被占用的轨道下标。
   * @param {number[]} banned 需要排除的下标（如当前显示、刚淡出、预缓冲位等）
   */
  _pickFree(banned) {
    const set = new Set(banned.filter((i) => i >= 0));
    for (let i = 0; i < this._vids.length; i++) {
      if (!set.has(i)) return i;
    }
    return 0; // 理论不可达：三个轨道不可能全部被禁用
  }

  /**
   * 把一段视频预加载到"完全隐藏"的轨道并暂停在首帧，等待被切换为显示。
   * - 落点用 _pickFree 排除"当前显示"与"刚淡出的旧轨道"，
   *   因此改 src / load 的轨道此刻 opacity=0，绝无黑帧外露。
   * - 到切换时刻该视频已解码完毕，直接起播即可，消除加载/解码造成的黑屏。
   * @param {string} src 要预缓冲的视频地址
   * @param {number} [justFaded] 刚淡出的旧轨道下标；预缓冲要避开它（虽已 opacity≈0，
   *   但 CSS 过渡尚未完，保守起见不碰，交由 _pickFree 排除）
   */
  _prebuffer(src, justFaded = -1) {
    const target = this._pickFree([this._active, justFaded]);
    const el = this._vids[target];
    // 已是该视频且已解码则无需重复加载
    if (el.src.endsWith(src) && el.readyState >= 2) {
      this._pre = target;
      return;
    }
    el.pause();
    if (!el.src.endsWith(src)) {
      el.src = src;
      el.load();
    }
    const reset = () => {
      el.pause();
      el.currentTime = 0; // 停在首帧，等待切换时从 0 重新起播
    };
    el.removeEventListener("loadeddata", reset);
    el.addEventListener("loadeddata", reset, { once: true });
    if (el.readyState >= 2) reset();
    this._pre = target;
  }

  /** 释放资源（页面卸载时调用）。 */
  destroy() {
    this._clearIdleListeners();
    for (const v of this._vids) {
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
    }
  }
}