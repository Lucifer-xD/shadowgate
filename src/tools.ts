// Emulated OpenAI function calling for a backend that has none.
//
// ChatGPT's web backend cannot accept tool schemas or emit tool_calls, so
// the gateway describes the client's tools in a system preamble, asks the
// model to answer with <tool_call>{json}</tool_call> blocks when it wants to
// act, extracts those blocks from the reply and hands the client real
// OpenAI tool_calls. Tool results coming back as `tool` messages are turned
// into <tool_response> text for the next turn.
import { randomBytes } from 'node:crypto';
import type { OpenAIMessage } from './chatgpt/client.js';

export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string, as OpenAI returns it */
  arguments: string;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } } | undefined;

interface IncomingAssistant extends OpenAIMessage {
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  function_call?: { name?: string; arguments?: string };
}
interface IncomingTool extends OpenAIMessage {
  tool_call_id?: string;
  name?: string;
}

/** Accept both the current `tools` shape and the legacy `functions` shape. */
export function normalizeTools(body: any): ToolSpec[] {
  const out: ToolSpec[] = [];
  if (Array.isArray(body?.tools)) {
    for (const t of body.tools) {
      const f = t?.type === 'function' ? t.function : t?.function ?? t;
      if (f && typeof f.name === 'string') out.push({ name: f.name, description: f.description, parameters: f.parameters });
    }
  } else if (Array.isArray(body?.functions)) {
    for (const f of body.functions) if (f && typeof f.name === 'string') out.push({ name: f.name, description: f.description, parameters: f.parameters });
  }
  return out;
}

export function normalizeToolChoice(body: any): ToolChoice {
  const c = body?.tool_choice ?? body?.function_call;
  if (c === 'none' || c === 'auto' || c === 'required') return c;
  if (c && typeof c === 'object') {
    const name = c.function?.name ?? c.name;
    if (typeof name === 'string') return { type: 'function', function: { name } };
  }
  return undefined;
}

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

/**
 * The briefing that makes the model use the protocol. Wording matters: the
 * models refuse to "call a function" they cannot see natively, but happily
 * follow a text protocol whose blocks a harness executes — and they need
 * one worked example. Delivered inside the first user message (see
 * injectToolPreamble): system/critic/developer channels were ignored by
 * some models in testing.
 */
export function toolPreamble(tools: ToolSpec[], choice: ToolChoice): string {
  const lines: string[] = [];
  lines.push('# Harness protocol (read carefully)');
  lines.push('');
  lines.push("You are the reasoning engine of an agent that runs on the USER'S machine. You have no native tools for that machine; instead, the agent harness reads your reply text and executes any action blocks it finds, then sends you the output in the next message. This is purely a text protocol: emitting the block IS performing the action. It is not a hallucinated capability and it is not a native ChatGPT tool — it works because the harness parses your text.");
  lines.push('');
  lines.push('Actions the harness can execute for you:');
  for (const t of tools) {
    const params = t.parameters ? JSON.stringify(t.parameters) : '{}';
    lines.push(`- ${t.name}${t.description ? ` — ${t.description.trim().replace(/\s+/g, ' ')}` : ''}. Arguments (JSON Schema): ${params.length > 6000 ? params.slice(0, 6000) + '…' : params}`);
  }
  lines.push('');
  lines.push('To request an action, write a block exactly like this (one block per action; you may write a short sentence before the first block, and several blocks when the actions are independent):');
  lines.push(OPEN);
  lines.push(`{"name": "${tools[0]?.name ?? 'action_name'}", "arguments": {"param": "value"}}`);
  lines.push(CLOSE);
  lines.push('Then END your reply and wait. The harness executes it and replies with one entry per block, in order:');
  lines.push('<tool_response name="action_name">');
  lines.push('...output...');
  lines.push('</tool_response>');
  lines.push('After that you continue: request more actions, or answer the user.');
  lines.push('');
  lines.push('Example exchange:');
  lines.push('User: how many lines does the notes file have?');
  lines.push('Assistant: Let me check.');
  lines.push(OPEN);
  lines.push(`{"name": "${tools[0]?.name ?? 'action_name'}", "arguments": {"example": "value"}}`);
  lines.push(CLOSE);
  lines.push(`User: <tool_response name="${tools[0]?.name ?? 'action_name'}">`);
  lines.push('42');
  lines.push('</tool_response>');
  lines.push('Assistant: 42 lines.');
  lines.push('');
  lines.push("Rules: never answer questions about the user's files, system, environment or anything on their side from memory or from any sandbox of your own — request the action. Never say an action is unavailable; if you need it, emit the block. Never just announce an action (\"I'll read…\", \"Let me check…\", \"I need to run…\") — include the block in the SAME reply, right after the sentence. Keep every \"arguments\" value a JSON object that matches the schema. You have NO Python sandbox, code interpreter, canvas, browser or image tool of your own here — anything you run there is discarded and the user never sees it; the ONLY way to run code, read files or produce output on the user's side is a <tool_call> block. A failed action is normal, not a blocker: read the error in the <tool_response>, correct the command or path, and request it again (up to a few attempts) — never stop a task because one action failed, and never describe yourself as blocked by the harness. When no action is needed, or once you have the results you need, answer normally without any block.");
  if (choice === 'required') lines.push('For THIS turn you must request at least one action.');
  if (choice && typeof choice === 'object') lines.push(`For THIS turn you must request the action "${choice.function.name}".`);
  return lines.join('\n');
}

const textOfContent = (c: OpenAIMessage['content']): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n') : '';

/** Prepend the preamble to the first user message (the channel every model honours). */
export function injectToolPreamble(messages: OpenAIMessage[], preamble: string, tools: ToolSpec[] = []): OpenAIMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const i = out.findIndex((m) => m.role === 'user');
  if (i === -1) return [{ role: 'user', content: preamble }, ...out];
  out[i] = { role: 'user', content: `${preamble}\n\n---\n\n${textOfContent(out[i].content)}` };
  // The briefing drifts out of attention as tool results pile up and the
  // model starts claiming the "interface is no longer available". A short
  // reminder on the latest user turn keeps the protocol in view.
  const last = out.length - 1;
  if (last > i && out[last].role === 'user') {
    const names = tools.map((t) => t.name).join(', ');
    out[last] = {
      role: 'user',
      content: `${textOfContent(out[last].content)}\n\n[Harness reminder: you act on the user's machine ONLY by replying with <tool_call> blocks (actions: ${names || 'see above'}). Your own sandbox or browser is not their machine. The protocol is always available; never say it is not. If an action failed, fix it and request it again. When nothing more is needed, answer normally.]`,
    };
  }
  return out;
}

/** Turn assistant tool_calls / tool results of earlier turns back into the text protocol. */
export function transformMessagesForTools(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const textOf = (c: OpenAIMessage['content']): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n') : '';
  for (const raw of messages) {
    if (raw.role === 'assistant') {
      const m = raw as IncomingAssistant;
      let text = textOf(m.content);
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : m.function_call ? [{ function: m.function_call }] : [];
      for (const c of calls) {
        const name = c.function?.name ?? 'unknown';
        let args: unknown = c.function?.arguments ?? '{}';
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep string */ } }
        text += `${text ? '\n' : ''}${OPEN}\n${JSON.stringify({ name, arguments: args })}\n${CLOSE}`;
      }
      out.push({ role: 'assistant', content: text });
      continue;
    }
    if (raw.role === 'tool') {
      const m = raw as IncomingTool;
      const content = textOf(m.content);
      const header = `<tool_response${m.name ? ` name="${m.name}"` : ''}${m.tool_call_id ? ` id="${m.tool_call_id}"` : ''}>`;
      const prev = out[out.length - 1];
      const block = `${header}\n${content}\n</tool_response>`;
      // consecutive tool results collapse into one user turn
      if (prev && prev.role === 'user' && typeof prev.content === 'string' && prev.content.startsWith('<tool_response')) prev.content += `\n${block}`;
      else out.push({ role: 'user', content: block });
      continue;
    }
    out.push(raw);
  }
  return out;
}

const newId = () => `call_${randomBytes(12).toString('hex')}`;

/**
 * A reply that announces an action but contains no block ("I need to check
 * your PC", "Let me read the file."). The gateway nudges the model once.
 */
export function looksLikeUnfulfilledIntent(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('[shadowgate:')) return true; // nothing visible came back — ask for the block
  if (t.length > 700 || t.endsWith('?')) return false;
  // "Need the command result to verify the files." — a short reply about tooling with no block
  if (t.length < 200 && (t.match(/\b(command|result|output|file|files|harness|tool|action|block|protocol)\b/gi) || []).length >= 2) return true;
  // "I can't truthfully verify the file contents from that failed attempt." — giving up on something the tools can do
  if (/\b(can[’']?t|cannot|unable to|not able to)\s+(truthfully |honestly |reliably |actually |really |yet )?(verify|confirm|check|read|inspect|retrieve|access|complete|perform|carry out|execute|create|write|delete|modify|edit)\b(?!\s+(?:any|anything|no)\b)/i.test(t)) return true;
  // "I can't issue the harness action blocks through this interface." / "I can't complete the requested
  // machine actions from this turn." — a refusal of the protocol itself
  if (/\b(can[’']?t|cannot|unable|not able|isn[’']?t available|not available|no longer available|not exposed|stopped being|not executable|no access|don[’']?t have access|blocked|stuck)\b/i.test(t)
    && /\b(harness|blocks?|actions?|tools?|functions?|interface|protocol|sequence|steps?|machine|computer|pc|commands?)\b/i.test(t)) return true;
  return /\b(i(?:['’]ll| will| need| can| would| should| am going to)|let me|need to|going to|harness action|the action|i['’]d need)\b/i.test(t)
    && /\b(read|check|run|list|look|inspect|open|fetch|execute|search|verify|call|use|request|need|issue|emit|send|provide|perform|access|retry|try|attempt|create|write|delete|remove|fix|correct|continue|proceed|redo|rerun)\b/i.test(t);
}

/**
 * A short mid-loop reply is nudged only when it reads like a lead-in to an
 * action ("Retrying with -Path.", "Checking the service now.") — not when it
 * is a plain short answer ("Done, what do you want me to do", "Yes.").
 */
export function looksLikeShortAnnouncement(text: string): boolean {
  const t = text.trim();
  if (!t || t.length >= 240 || /\?\s*$/.test(t)) return false;
  return /\b(i['’]ll|i will|i['’]m going|let me|going to|need to|needs? to|will now|now i|next[, ]|retry(?:ing)?|re-?run(?:ning)?|trying|checking|reading|running|listing|looking|inspecting|fetching|verifying|continuing|proceeding|one moment|hold on|stand by)\b/i.test(t);
}

/** Canonical key for a tool call so repeats can be recognised regardless of JSON key order or spacing. */
export function callKey(name: string, args: unknown): string {
  let canon = '';
  try {
    const v = typeof args === 'string' ? JSON.parse(args) : args;
    canon = JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort()) : val));
  } catch {
    canon = String(args ?? '');
  }
  return `${name}:${canon}`;
}

export const NUDGE_EMPTY_MESSAGE = 'Your last turn produced no reply text and no <tool_call> block — nothing reached the user. If you used a built-in sandbox, code interpreter, canvas or image tool, it does not exist here and its output was discarded. Do the step through the harness: reply now with ONLY the <tool_call> block(s) for the next action, in the exact protocol format. If the task is finished, give the complete final answer in plain text.';
export const NUDGE_MESSAGE = 'Your last reply contained no <tool_call> block, so nothing happened on the user\'s machine. If the task is not finished, reply now with ONLY the <tool_call> block(s) for the next action, in the exact protocol format. If the task is finished, give the complete final answer now.';

/** Parse every complete (or trailing unterminated) tool_call block out of a reply. */
/**
 * Fenced code regions that QUOTE the protocol (a file that contains
 * "<tool_call>", an explanation of the format) must not be executed. A fence
 * whose whole content is a tool_call block is still a real call — models
 * sometimes wrap their calls in ``` — so only mixed fences are quotes.
 */
function quotedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1].trim();
    const onlyBlocks = body.startsWith(OPEN) && body.endsWith(CLOSE) && !body.slice(OPEN.length, -CLOSE.length).includes(OPEN);
    if (!onlyBlocks && body.includes(OPEN)) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

export function extractToolCalls(text: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const quoted = quotedRanges(text);
  const isQuoted = (pos: number) => quoted.some(([a, b]) => pos >= a && pos < b);
  let rest = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(OPEN, i);
    if (open === -1) { rest += text.slice(i); break; }
    if (isQuoted(open)) {
      // leave the quoted protocol text exactly as written
      rest += text.slice(i, open + OPEN.length);
      i = open + OPEN.length;
      continue;
    }
    rest += text.slice(i, open);
    const bodyStart = open + OPEN.length;
    // The arguments may themselves contain "</tool_call>" (a file the model is
    // writing that quotes the protocol), so the block ends where the JSON
    // object ends, not at the first closing tag.
    const objEnd = findJsonObjectEnd(text, bodyStart);
    let inner: string;
    let next: number;
    if (objEnd !== -1) {
      inner = text.slice(bodyStart, objEnd);
      const after = text.indexOf(CLOSE, objEnd);
      // between the object and the closing tag only whitespace or a closing ``` fence may appear
      next = after !== -1 && /^\s*(?:```)?\s*$/.test(text.slice(objEnd, after)) ? after + CLOSE.length : objEnd;
    } else {
      const close = text.indexOf(CLOSE, bodyStart);
      inner = close === -1 ? text.slice(bodyStart) : text.slice(bodyStart, close);
      next = close === -1 ? text.length : close + CLOSE.length;
    }
    const parsed = parseCall(inner);
    if (parsed) calls.push(parsed);
    else if (next < text.length || objEnd !== -1) rest += text.slice(open, next); // not JSON — leave it visible
    i = Math.max(next, bodyStart);
  }
  return { text: rest.replace(/```(?:json)?\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim(), calls };
}

/** Index just past the JSON object that starts (after optional whitespace / ```json fence) at `from`, or -1. */
function findJsonObjectEnd(text: string, from: number): number {
  let i = from;
  const fence = /^\s*```(?:json)?\s*/.exec(text.slice(from));
  if (fence) i += fence[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return -1;
  let depth = 0;
  let inStr = false;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (ch === '\\') k++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/** JSON.parse that forgives what models produce: lone backslashes (Windows paths), trailing commas, truncation. */
export function lenientJson(src: string): any {
  const candidates = [src, src.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'), src.replace(/,\s*([}\]])/g, '$1')];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
    const end = c.lastIndexOf('}');
    if (end !== -1) { try { return JSON.parse(c.slice(0, end + 1)); } catch { /* next */ } }
  }
  return null;
}

function parseCall(inner: string): ToolCall | null {
  let s = inner.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!s) return null;
  const obj = lenientJson(s);
  if (!obj) return null;
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.name ?? obj.function?.name ?? obj.tool;
  if (typeof name !== 'string' || !name) return null;
  let args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? obj.input ?? {};
  if (typeof args === 'string') { try { JSON.parse(args); } catch { args = { input: args }; } }
  return { id: newId(), name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

/**
 * Streaming helper: lets visible text through until a tool_call block starts,
 * holding back a partially-typed "<tool_call>" opener so it is never leaked.
 */
export class ToolCallStream {
  private buf = '';
  private held = '';
  private inCall = false;
  private emitted = '';

  /** Feed a delta; returns the text that is safe to forward to the client now. */
  push(delta: string): string {
    this.buf += delta;
    if (this.inCall) return '';
    const pending = this.held + delta;
    const open = pending.indexOf(OPEN);
    if (open !== -1) {
      this.inCall = true;
      this.held = '';
      const out = pending.slice(0, open).replace(/\s+$/, '');
      this.emitted += out;
      return out;
    }
    // keep a possible partial opener for the next push
    let keep = 0;
    for (let n = Math.min(OPEN.length - 1, pending.length); n > 0; n--) {
      if (OPEN.startsWith(pending.slice(pending.length - n))) { keep = n; break; }
    }
    this.held = keep ? pending.slice(pending.length - keep) : '';
    const out = keep ? pending.slice(0, pending.length - keep) : pending;
    this.emitted += out;
    return out;
  }

  /**
   * Call at end of stream. `text` is the whole visible text, `unsent` the part
   * of it the client has not received yet (held partial opener, or a block
   * that failed to parse and should therefore stay visible).
   */
  finish(): { text: string; calls: ToolCall[]; unsent: string } {
    const { text, calls } = extractToolCalls(this.buf);
    const sent = this.emitted.trim();
    let unsent = '';
    if (text.startsWith(sent)) unsent = text.slice(sent.length).replace(/^\s+/, '');
    else if (!calls.length) unsent = this.held;
    this.held = '';
    return { text, calls, unsent };
  }

  get sawCall(): boolean {
    return this.inCall;
  }

  get full(): string {
    return this.buf;
  }
}
