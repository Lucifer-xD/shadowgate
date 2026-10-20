// Summarising compaction: when a request cannot continue an existing backend
// conversation and its history is over the per-request budget, condense the
// middle of the conversation with a fast model instead of clipping it blindly.
// The system prompt, the first user message and the latest turns stay verbatim.
import crypto from 'node:crypto';
import type { OpenAIMessage } from './chatgpt/client.js';
import { runCompletion } from './engine.js';
import type { TokenPool } from './pool.js';
import type { Store } from './store.js';

const KEEP_TAIL = 6; // latest messages kept verbatim
const MIN_MIDDLE_CHARS = 20_000; // below this, summarising is not worth a model call
const MAX_TRANSCRIPT_CHARS = 280_000; // one summariser request (under the backend's single-message cap)

const SUMMARY_TIMEOUT_MS = 90_000;
const SUMMARISER_MODEL = 'gpt-5-6-instant';

const cache = new Map<string, string>(); // hash(middle) → summary
const CACHE_MAX = 60;

const textOf = (c: OpenAIMessage['content']): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n') : '';

export interface Partition {
  head: OpenAIMessage[];
  middle: OpenAIMessage[];
  tail: OpenAIMessage[];
}

/**
 * Split a history into the parts that stay verbatim (head, tail) and the part
 * to condense (middle). The head is the system prompt(s) plus the first user
 * message when it is a normal-sized task statement (a huge first message is
 * data and gets condensed too). The tail is the latest messages, as many as
 * `keepTail` while they fit in `tailBudget` characters; the last message is
 * always kept.
 */
export function partitionHistory(messages: OpenAIMessage[], keepTail = KEEP_TAIL, tailBudget = 150_000, headUserMax = 20_000): Partition {
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd].role === 'system') headEnd++;
  const firstUser = messages.findIndex((m, i) => i >= headEnd && m.role === 'user');
  if (firstUser !== -1 && textOf(messages[firstUser].content).length <= headUserMax) headEnd = firstUser + 1;
  let tailStart = messages.length;
  let tailChars = 0;
  while (tailStart > headEnd && messages.length - tailStart < keepTail) {
    const size = textOf(messages[tailStart - 1].content).length;
    if (tailStart < messages.length && tailChars + size > tailBudget) break;
    tailChars += size;
    tailStart--;
  }
  return { head: messages.slice(0, headEnd), middle: messages.slice(headEnd, tailStart), tail: messages.slice(tailStart) };
}

/**
 * Cut the middle into segments that each fit one summariser request, keeping
 * messages whole wherever possible (a single message above the segment size
 * is clipped head-and-tail). Every segment is summarised on its own, so a
 * long middle costs several short calls instead of losing content.
 */
export function segmentMiddle(middle: OpenAIMessage[], segmentChars = MAX_TRANSCRIPT_CHARS): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const m of middle) {
    let t = textOf(m.content);
    if (t.length > segmentChars - 200) t = `${t.slice(0, Math.floor(segmentChars * 0.6))}\n…[${t.length - segmentChars} chars omitted]…\n${t.slice(-Math.floor(segmentChars * 0.35))}`;
    const line = `### ${m.role}\n${t}\n`;
    if (current.length && size + line.length > segmentChars) { segments.push(current.join('\n')); current = []; size = 0; }
    current.push(line);
    size += line.length;
  }
  if (current.length) segments.push(current.join('\n'));
  return segments;
}

const PROMPT = `You compress the middle of a long conversation between a user, an AI agent and the tools the agent ran, so the agent can carry on without the original text. Write a dense, factual summary in plain prose and bullet points. Keep EVERY concrete detail that could matter later: file paths, names, identifiers, keys, numbers, commands, error messages, decisions taken, results obtained, what was tried and failed, and open tasks. Do not add commentary, do not say "the user asked"; state facts. No length limit beyond what the details need.`;

/**
 * Replace the middle of a history with a model-written summary. Returns null
 * when there is nothing worth summarising or the summariser failed; the caller
 * then falls back to clipping.
 */
export async function summarizeHistory(pool: TokenPool, store: Store, messages: OpenAIMessage[], budget = 480_000, signal?: AbortSignal): Promise<{ messages: OpenAIMessage[]; summarised: number } | null> {
  const { head, middle, tail } = partitionHistory(messages, KEEP_TAIL, Math.floor(budget * 0.3));
  const middleChars = middle.reduce((n, m) => n + textOf(m.content).length, 0);
  if (middle.length < 2 || middleChars < MIN_MIDDLE_CHARS) return null;
  const segments = segmentMiddle(middle);
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const key = crypto.createHash('sha256').update(seg).digest('hex');
    let part = cache.get(key);
    if (!part) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), SUMMARY_TIMEOUT_MS);
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const r = await runCompletion({
          pool,
          store,
          model: SUMMARISER_MODEL,
          messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: `Conversation to compress (part ${i + 1} of ${segments.length}):\n\n${seg}` }],
          signal: ctl.signal,
        });
        if (!r.ok || !r.text.trim() || r.text.startsWith('[shadowgate:')) return null;
        part = r.text.trim();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      cache.set(key, part);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    }
    parts.push(segments.length > 1 ? `## Part ${i + 1} of ${segments.length}\n${part}` : part);
  }
  const summary = parts.join('\n\n');
  const note: OpenAIMessage = {
    role: 'user',
    content: `[Conversation summary — ${middle.length} earlier messages were condensed by the gateway to fit the backend's request budget. Every identifier, path, number, decision and open task was kept.]\n\n${summary}`,
  };
  const ack: OpenAIMessage = { role: 'assistant', content: 'Understood — I have the summary of the earlier conversation and will continue from here.' };
  return { messages: [...head, note, ack, ...tail], summarised: middle.length };
}

/** Test hook. */
export function _resetSummaryCache(): void {
  cache.clear();
}
