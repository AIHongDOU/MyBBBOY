// @ts-check
/**
 * 豆包（火山引擎）双向流式 TTS V3 协议浏览器客户端。
 *
 * 浏览器无法为 WebSocket 设置自定义请求头（豆包鉴权需要 X-Api-Key /
 * X-Api-Resource-Id），所以本客户端经本地 server.py 的 /api/doubao-tts 代理连接，
 * token / resourceId 作为查询参数传入，由代理注入请求头后透明中继二进制帧。
 *
 * 用途：把一句文本合成成 PCM16 单声道音频（默认 24 kHz），供 s2s-ws-client 在
 * "doubao" provider 下替换智谱 GLM 自带的语音输出（实现自定义御姐音色）。
 *
 * 用法：
 *   const tts = new DoubaoTtsClient({ token, resourceId, speaker });
 *   tts.addEventListener("audio", (e) => playPcm(e.detail.pcm));
 *   await tts.connect();
 *   tts.synthesize("第一句");   // 自动排队、串行合成
 *   tts.synthesize("第二句");
 *   tts.close();
 *
 * 事件：
 *   "sentence-start" -> { sentence: string }
 *   "audio"          -> { pcm: ArrayBuffer }  原始 PCM16 24kHz 字节
 *   "sentence-end"   -> {}                    当前一句合成完成
 *   "error"          -> { error: Error }
 */

const PROXY_BASE = "/api/doubao-tts";

// ---- 帧/协议常量（与 node 探针脚本一致）----
const PROTOCOL_VERSION = 0b0001;
const DEFAULT_HEADER_SIZE = 0b0001;
const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_RESPONSE = 0b1011;
const FULL_SERVER_RESPONSE = 0b1001;
const ERROR_INFORMATION = 0b1111;
const MsgTypeFlagWithEvent = 0b100;
const JSON_SERIAL = 0b0001;
const COMPRESSION_NO = 0b0000;

/** 数字事件编号 */
const EV = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
};

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** @param {number} messageType @param {number} flags @returns {Uint8Array} */
function buildHeader(messageType, flags) {
  const b1 = (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE;
  const b2 = (messageType << 4) | flags;
  const b3 = (JSON_SERIAL << 4) | COMPRESSION_NO;
  return new Uint8Array([b1, b2, b3, 0x00]);
}

/**
 * Header(4B) + Optional(event[4B] + sessionId[4B len + bytes]) + payloadSize(4B) + payload
 * @param {number} event
 * @param {string | null} sessionId
 * @param {string} payloadStr
 * @returns {Uint8Array}
 */
function buildEventFrame(event, sessionId, payloadStr) {
  const header = buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent);
  const evBuf = new Uint8Array(4);
  new DataView(evBuf.buffer).setInt32(0, event);
  const parts = [header, evBuf];
  if (sessionId) {
    const sid = new TextEncoder().encode(sessionId);
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setInt32(0, sid.byteLength);
    parts.push(lenBuf, sid);
  }
  const payload = new TextEncoder().encode(payloadStr || "");
  const sizeBuf = new Uint8Array(4);
  new DataView(sizeBuf.buffer).setInt32(0, payload.byteLength);
  parts.push(sizeBuf, payload);
  return concatBytes(parts);
}

/**
 * @param {number} event
 * @param {{ uid: string; text: string; speaker: string; format: string; sampleRate: number }} o
 * @returns {string}
 */
function buildPayload(event, o) {
  return JSON.stringify({
    user: { uid: o.uid },
    event,
    namespace: "BidirectionalTTS",
    req_params: {
      text: o.text,
      speaker: o.speaker,
      audio_params: { format: o.format, sample_rate: o.sampleRate },
    },
  });
}

/**
 * @param {ArrayBuffer} buf
 * @returns {{ msgType: number; event: number | null; sessionId: string | null; payload: Uint8Array } | null}
 */
function parseMessage(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.byteLength < 4) return null;
  const view = new DataView(buf);
  const headerSize = u8[0] & 0x0f;
  const msgType = u8[1] >> 4;
  const flags = u8[1] & 0x0f;
  let offset = headerSize * 4;
  let event = null;
  let sessionId = null;
  if (flags & MsgTypeFlagWithEvent) {
    if (u8.byteLength < offset + 4) return null;
    event = view.getInt32(offset);
    offset += 4;
  }
  if (flags === MsgTypeFlagWithEvent && offset + 4 <= u8.byteLength) {
    const sidLen = view.getInt32(offset);
    if (sidLen >= 0 && sidLen < 1000 && offset + 4 + sidLen <= u8.byteLength) {
      sessionId = new TextDecoder().decode(u8.subarray(offset + 4, offset + 4 + sidLen));
      offset += 4 + sidLen;
    }
  }
  if (u8.byteLength < offset + 4) return null;
  const payloadSize = view.getInt32(offset);
  offset += 4;
  if (u8.byteLength < offset + payloadSize) return null;
  const payload = u8.subarray(offset, offset + payloadSize);
  return { msgType, flags, event, sessionId, payload };
}

/** @typedef {Object} DoubaoTtsOptions
 * @property {string} token 豆包 Access Token（X-Api-Key）
 * @property {string} [resourceId] 资源 ID，默认 seed-tts-2.0
 * @property {string} speaker 音色 ID（如御姐）
 * @property {"pcm" | "mp3" | "wav" | "opus"} [format] 音频格式，默认 pcm
 * @property {number} [sampleRate] 采样率，默认 24000
 * @property {string} [uid] 用户标识，默认 "10001" */

export class DoubaoTtsClient extends EventTarget {
  /** @param {DoubaoTtsOptions} opts */
  constructor(opts) {
    super();
    this._token = opts.token || "";
    this._resourceId = opts.resourceId || "seed-tts-2.0";
    this._speaker = opts.speaker || "";
    this._format = opts.format || "pcm";
    this._sampleRate = opts.sampleRate || 24000;
    this._uid = opts.uid || "10001";
    /** @type {WebSocket | null} */
    this._ws = null;
    this._sessionId = "";
    /** 连接就绪（ConnectionStarted 已收到）。 */
    this._connReady = false;
    /** 当前 session 就绪（SessionStarted 已收到）。 */
    this._sessionReady = false;
    /** @type {string[]} */
    this._queue = [];
    /** 当前是否在合成一个 TaskRequest。 */
    this._active = false;
    this._currentText = "";
    /** 当前 TaskRequest 是否已发 FinishSession。 */
    this._finishSent = false;
    /** @type {ReturnType<typeof setTimeout> | null} 音频空闲计时器：检测一句合成结束。 */
    this._audioIdleTimer = null;
    /** 音频空闲阈值（ms）：超过该时长无新音频 chunk，视为当前句合成完成。 */
    this._audioIdleMs = 1000;
    this._closed = false;
    /** @type {((v: void) => void) | null} */
    this._connectResolve = null;
    /** @type {((e: Error) => void) | null} */
    this._connectReject = null;
  }

  /** Resolve once the V3 handshake is done (SessionStarted). */
  connect() {
    return new Promise((resolve, reject) => {
      if (!this._token) {
        reject(new Error("豆包缺少 Access Token。"));
        return;
      }
      const url = `${PROXY_BASE}?token=${encodeURIComponent(this._token)}&resourceId=${encodeURIComponent(this._resourceId)}`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this._ws = ws;
      this._connectResolve = resolve;
      this._connectReject = reject;
      ws.addEventListener("open", () => {
        // 1. StartConnection
        this._sendFrame(EV.StartConnection, null, "");
      });
      ws.addEventListener("message", (e) => {
        const msg = parseMessage(e.data);
        if (msg) this._onMessage(msg);
      });
      ws.addEventListener("error", () => {
        this._fail(new Error("豆包 TTS 连接失败。"));
      });
      ws.addEventListener("close", () => {
        this._connReady = false;
        this._sessionReady = false;
        this._active = false;
        this._clearIdleTimer();
      });
    });
  }

  /** 把一句文本加入合成队列（串行处理）。 */
  synthesize(text) {
    const t = (text || "").trim();
    if (!t || this._closed) return;
    this._queue.push(t);
    // 跨轮对话：上一轮 SessionFinished 后 session 已结束（_sessionReady=false）。
    // 若连接仍就绪，需主动开启新一轮 session，否则 _flush 永远无法发 TaskRequest。
    if (!this._sessionReady && this._connReady) {
      this._startNewSession();
      return; // 等 SessionStarted 后由 _flush 自动消费队列
    }
    this._flush();
  }

  _flush() {
    if (!this._sessionReady || this._active || this._queue.length === 0) return;
    this._active = true;
    this._finishSent = false;
    this._currentText = this._queue.shift();
    // 3. TaskRequest（携带文本）
    this._sendFrame(EV.TaskRequest, this._sessionId, this._currentText);
  }

  /** 收到音频后重置"空闲"计时；空闲超时即认为当前句合成结束，发 FinishSession。 */
  _onAudioChunk() {
    this._clearIdleTimer();
    if (this._active && !this._finishSent) {
      this._audioIdleTimer = setTimeout(() => {
        this._audioIdleTimer = null;
        if (this._active && !this._finishSent) {
          this._finishSent = true;
          this._sendFrame(EV.FinishSession, this._sessionId, this._currentText);
        }
      }, this._audioIdleMs);
    }
  }

  _clearIdleTimer() {
    if (this._audioIdleTimer) {
      clearTimeout(this._audioIdleTimer);
      this._audioIdleTimer = null;
    }
  }

  /** @param {number} event @param {string | null} sessionId @param {string} text */
  _sendFrame(event, sessionId, text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const payload = buildPayload(event, {
      uid: this._uid,
      text,
      speaker: this._speaker,
      format: this._format,
      sampleRate: this._sampleRate,
    });
    this._ws.send(buildEventFrame(event, sessionId, payload).buffer);
  }

  /** @param {{ msgType: number; event: number | null; sessionId: string | null; payload: Uint8Array }} msg */
  _onMessage({ msgType, event, payload }) {
    if (msgType === ERROR_INFORMATION) {
      const msg = new TextDecoder().decode(payload).slice(0, 300);
      console.error("[doubao-tts] server error:", msg);
      this._fail(new Error(`豆包 TTS 服务端错误：${msg}`));
      return;
    }
    if (msgType === AUDIO_ONLY_RESPONSE) {
      // 原始 PCM16 字节（拷贝成独立 ArrayBuffer，便于 transfer 给播放 worklet）
      const pcm = payload.slice().buffer;
      this._onAudioChunk(); // 重置空闲计时：检测当前句合成结束
      this.dispatchEvent(new CustomEvent("audio", { detail: { pcm } }));
      return;
    }
    if (msgType !== FULL_SERVER_RESPONSE) return;
    let obj = null;
    try {
      obj = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      /* ignore */
    }
    const e = obj?.event ?? event;
    switch (e) {
      case EV.ConnectionStarted:
        this._connReady = true;
        // 2. 首轮 StartSession
        this._startNewSession();
        break;
      case EV.SessionStarted:
        this._sessionReady = true;
        this._connectResolve?.();
        this._connectResolve = null;
        this._flush();
        break;
      case EV.TTSSentenceStart:
        this.dispatchEvent(new CustomEvent("sentence-start", { detail: { sentence: this._currentText } }));
        break;
      case EV.TTSSentenceEnd:
        // 一句音频结束标记（仅供参考）：真正收敛靠"音频空闲 -> FinishSession -> SessionFinished"。
        break;
      case EV.SessionFinished:
        // 当前 TaskRequest 已全部播完：通知上层、释放处理槽。
        this._sessionReady = false;
        this._active = false;
        this._finishSent = false;
        this._clearIdleTimer();
        this.dispatchEvent(new CustomEvent("sentence-end"));
        // 若队列还有文本，开启新一轮 session 继续合成（官方：收到 SessionFinished 后必须重新 StartSession）。
        if (this._queue.length > 0) {
          this._startNewSession();
        }
        break;
      case EV.ConnectionFailed:
      case EV.SessionFailed: {
        const msg = new TextDecoder().decode(payload).slice(0, 300);
        console.error("[doubao-tts] failed:", e, msg);
        this._fail(new Error(`豆包 TTS 失败：${msg}`));
        break;
      }
      default:
        break;
    }
  }

  /** 开启新一轮 session（每个 TaskRequest 必须用独立 session）。 */
  _startNewSession() {
    this._sessionReady = false;
    this._sessionId = crypto.randomUUID();
    this._sendFrame(EV.StartSession, this._sessionId, "");
  }

  /** @param {Error} err */
  _fail(err) {
    this.dispatchEvent(new CustomEvent("error", { detail: { error: err } }));
    this._connectReject?.(err);
    this._connectReject = null;
  }

  close() {
    this._closed = true;
    this._connReady = false;
    this._sessionReady = false;
    this._active = false;
    this._clearIdleTimer();
    try {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._sendFrame(EV.FinishConnection, null, "");
        this._ws.close(1000, "client closed");
      }
    } catch {
      /* ignored */
    }
    this._ws = null;
  }
}