// @ts-check
/**
 * 记忆提炼器：把"对话"变成"长期记忆"。
 *
 * 之前的记忆层只存最近 12 轮原始对话，信息庞杂、不够聚焦，也不够自然。
 * 本模块用智谱 GLM（chat completions）从每一轮对话中提炼出值得长期记住的
 * 用户偏好与关键事实，去重后持久化到 localStorage。这样：
 *
 *  - 更长久：事实库不设轮数上限，只按条数裁剪（MAX_FACTS），偏好能一直留着；
 *  - 更准确：由模型只抽取有长期价值的信息，过滤寒暄和一次性话题；
 *  - 更自然：开场时把"小姚记得的事"作为简洁陈述注入，而不是逐句复述对话。
 *
 * 说明：对话大脑是智谱（zhipu / doubao 两种 provider 都复用智谱 key），提炼走
 * 同源代理 /api/memory/refine（见 server.py），由后端代调智谱 chat completions，
 * 规避浏览器直连第三方接口的 CORS 问题。提炼用轻量模型 glm-4-flash，成本极低。
 */

/** 记忆提炼用的本地代理端点（server.py 转发到智谱 chat completions）。 */
const REFINE_ENDPOINT = "api/memory/refine";
/** localStorage 键名（长期事实库）。 */
const FACTS_KEY = "s2s.memory.facts";
/** 事实库条数上限（超出后丢弃最旧的，避免无限膨胀）。 */
const MAX_FACTS = 60;
/** 拼进 instructions 的事实段落标题。 */
const FACTS_HEADER = "\n\n【小姚记得的关于你的事】（以下是我长期记住的你；无需提及没用到的事）";

/** 读取长期事实。损坏/不可用时返回空数组。 */
export function loadFacts() {
  try {
    const raw = localStorage.getItem(FACTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((f) => typeof f === "string" && f.trim());
  } catch {
    return [];
  }
}

/** 写回长期事实（按时间顺序，最新在后）。 */
export function saveFacts(facts) {
  try {
    localStorage.setItem(FACTS_KEY, JSON.stringify(facts.slice(-MAX_FACTS)));
  } catch {
    // 存储满/被禁用时静默失败，不影响对话。
  }
}

/**
 * 调用本地 /api/memory/refine 代理，把对话交给智谱提炼，返回模型原文。
 * @param {string} zhipuKey
 * @param {string} user
 * @param {string} assistant
 * @returns {Promise<string>}
 */
async function callGLM(zhipuKey, user, assistant) {
  const res = await fetch(REFINE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: zhipuKey, user, assistant }),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const j = await res.json();
      detail = j?.detail || detail;
    } catch {}
    throw new Error(`GLM refine error (${detail})`);
  }
  const data = await res.json();
  return data?.facts || "";
}

/**
 * 从模型输出里解析出 JSON 字符串数组。模型可能把数组包在 markdown 代码块里，
 * 或混入多余说明，这里做宽容解析。
 * @param {string} raw
 * @returns {string[]}
 */
function parseFacts(raw) {
  if (!raw) return [];
  const cleaned = raw.trim().replace(/^```(?:json)?|```$/g, "").trim();
  // 提取第一个 [ ... ] 数组。
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(arr)) {
        return arr
          .map((f) => (typeof f === "string" ? f.trim() : ""))
          .filter(Boolean);
      }
    } catch {}
  }
  // 兜底：按行切分。
  return cleaned
    .split(/\n+/)
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
}

/** 归一化：去空白、标点、全角转半角、转小写，用于去重比较。 */
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[\u3000\s，。！？、；：（）()【】\[\]“”"'‘’·、—…,.!?;:'"\-]/g, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 两个归一化字符串是否"近似重复"（子串包含，或用字符 bigram 的 Jaccard 判断）。 */
function similar(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const bigrams = (/** @type {string} */ s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (!ba.size || !bb.size) return false;
  let inter = 0;
  for (const b of ba) if (bb.has(b)) inter++;
  const union = ba.size + bb.size - inter;
  return union > 0 && inter / union > 0.6;
}

/**
 * 把新提炼的事实合并进现有库：
 *  - 与已有事实近似重复的新事实被丢弃（保留旧的、更长的表述）；
 *  - 保留的顺序有时间先后，便于后续裁剪最旧的。
 * @param {string[]} existing
 * @param {string[]} incoming
 * @returns {string[]}
 */
export function mergeFacts(existing, incoming) {
  const pool = [...existing];
  for (const f of incoming) {
    const dup = pool.some((p) => similar(p, f));
    if (!dup) pool.push(f);
  }
  return pool.slice(-MAX_FACTS);
}

/**
 * 从一轮对话提炼长期事实并合并入库。异步、可失败：任何异常都被吞掉，
 * 不影响对话主流程（记忆是锦上添花，不是刚需）。
 * @param {string} zhipuKey
 * @param {string} user
 * @param {string} assistant
 * @returns {Promise<void>}
 */
export async function refineTurn(zhipuKey, user, assistant) {
  const key = (zhipuKey || "").trim();
  const u = (user || "").trim();
  const a = (assistant || "").trim();
  if (!key || !u || !a) return;
  try {
    const raw = await callGLM(key, u, a);
    const facts = parseFacts(raw);
    if (!facts.length) return;
    saveFacts(mergeFacts(loadFacts(), facts));
  } catch (err) {
    console.warn("[memory] refine failed:", err instanceof Error ? err.message : err);
  }
}

/** 生成要拼进 instructions 的长期事实段落。空事实时返回空字符串。 */
export function buildFactsPrompt() {
  const facts = loadFacts();
  if (!facts.length) return "";
  return `${FACTS_HEADER}\n${facts.map((f) => `- ${f}`).join("\n")}`;
}