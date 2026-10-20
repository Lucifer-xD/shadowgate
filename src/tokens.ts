// Exact token accounting with OpenAI's o200k_base encoding (the one GPT-5/6
// use). Counting is synchronous and fast enough for request-sized text; a
// small cache avoids re-encoding the same prompt on retries and nudges.
import crypto from 'node:crypto';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import type { OpenAIMessage } from './chatgpt/client.js';

const cache = new Map<string, number>();
const CACHE_MAX = 200;

/** Token count of a string (exact for text; images are counted by the caller). */
export function countTokens(text: string): number {
  if (!text) return 0;
  const key = text.length > 2000 ? crypto.createHash('sha1').update(text).digest('hex') : `s:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let n: number;
  try {
    n = encode(text).length;
  } catch {
    n = Math.max(1, Math.round(text.length / 4));
  }
  cache.set(key, n);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return n;
}

/** Image parts are billed by the backend's own rules; 765 tokens is the usual cost of a standard-detail image. */
const IMAGE_TOKENS = 765;
/** Per-message framing overhead in a chat template. */
const MESSAGE_OVERHEAD = 4;

/** Token count of a whole message list, the way a chat prompt is counted. */
export function countMessageTokens(messages: OpenAIMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += MESSAGE_OVERHEAD;
    const c = m.content;
    if (typeof c === 'string') n += countTokens(c);
    else if (Array.isArray(c)) for (const p of c) n += p.type === 'text' ? countTokens(p.text ?? '') : p.type === 'image_url' ? IMAGE_TOKENS : 0;
  }
  return n;
}
