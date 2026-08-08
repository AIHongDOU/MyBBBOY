// @ts-check
/**
 * 记忆层：让虚拟人"记得"你和它聊过什么。
 *
 * 纯前端实现，零后端改动：
 * - 拦截完整对话回合（user 说完 + assistant 说完）写入 localStorage；
 * - 仅保留最近 N 轮（MEMORY_MAX_TURNS），避免无限膨胀；
 * - 开场时把"长期事实 + 最近对话"拼进 instructions，让模型带着记忆开口。
 *
 * 长期事实由 memory-refiner.js 用智谱 GLM 从对话中提炼并持久化，本文件只负责
 * 把它们和最近几轮对话组合成一段自然的记忆提示。
 *
 * 存储结构：`{ turns: [{ user, assistant, ts }], ... }`，按时间顺序追加。
 */

import { buildFactsPrompt } from "./memory-refiner.js";

/** localStorage 键名。 */
const MEMORY_KEY = "s2s.memory.turns";
/** 最多保留的对话轮数（1 轮 = 用户一句 + 助手一句）。 */
const MEMORY_MAX_TURNS = 12;
/** 实际拼进指令的最近对话轮数（比存储上限小，避免提示过长、喧宾夺主）。 */
const MEMORY_PROMPT_TURNS = 4;
/** 拼进 instructions 的近期对话段落标题。 */
const MEMORY_HEADER = "\n\n【最近聊过】（仅作衔接参考，别逐句复述）";

/** 读取最近对话。失败（损坏/不可用）时返回空数组。 */
export function loadMemoryTurns() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t) =>
        t &&
        typeof t.user === "string" &&
        typeof t.assistant === "string" &&
        t.user.trim() &&
        t.assistant.trim(),
    );
  } catch {
    return [];
  }
}

/**
 * 记录一轮对话。`user` / `assistant` 为这一轮的完整文本。
 * 追加后裁剪到最近 MEMORY_MAX_TURNS 轮并写回。
 */
export function rememberTurn(user, assistant) {
  const u = typeof user === "string" ? user.trim() : "";
  const a = typeof assistant === "string" ? assistant.trim() : "";
  if (!u || !a) return;
  const turns = loadMemoryTurns();
  turns.push({ user: u, assistant: a, ts: Date.now() });
  const kept = turns.slice(-MEMORY_MAX_TURNS);
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(kept));
  } catch {
    // 存储满/被禁用时静默失败，不影响对话。
  }
}

/** 清空记忆（预留，供未来"忘掉我"功能使用）。 */
export function clearMemory() {
  try {
    localStorage.removeItem(MEMORY_KEY);
  } catch {}
}

/**
 * 生成要拼进 instructions 的记忆段落。
 * 结构：先是"长期记住的事"（来自记忆提炼器），再是最近几轮对话作衔接。
 * 两者都为空时返回空字符串（调用方应直接忽略）。
 */
export function buildMemoryPrompt() {
  const facts = buildFactsPrompt();
  const turns = loadMemoryTurns().slice(-MEMORY_PROMPT_TURNS);
  const lines = [];
  if (facts) lines.push(facts);
  if (turns.length) {
    const dia = [];
    for (const t of turns) {
      dia.push(`用户：${t.user}`);
      dia.push(`小姚：${t.assistant}`);
    }
    lines.push(`${MEMORY_HEADER}\n${dia.join("\n")}`);
  }
  if (!lines.length) return "";
  return `${lines.join("\n")}\n（自然地延续话题，不要逐句复述上面的对话。）`;
}