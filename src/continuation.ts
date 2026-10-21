// Conversation continuation: when a request is "the previous conversation plus
// a few new messages", send only the new messages into the backend conversation
// we already have, instead of re-uploading the whole history every turn.
//
// Keys are hashes of the full message list a request carried (roles + text,
// image parts by content hash). A later request whose prefix hashes to a known
// key, followed by the assistant turn and one or more user/tool messages, is a
// continuation. Anything else — edited history, compaction, a different model
// or effort — misses and falls back to a full resend, which is always correct.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { OpenAIMessage } from './chatgpt/client.js';

export interface ContinuationEntry {
  conversationId: string;
  /** id of the backend's last assistant message — the parent for the next turn */
  parentId: string;
  /** pool token (account) that owns the conversation */
  tokenId: string;
  /** upstream slug the conversation runs on */
  model: string;
  /** true when the conversation is saved in the account's history (work-mode models need that to continue) */
  persisted: boolean;
  createdAt: number;
  lastUsed: number;
  turns: number;
}

/**
 * Whether the backend will really continue this conversation in place. A
 * work-mode ("-wm") conversation continues only when it is saved; inside a
 * temporary chat the backend silently drops it to gpt-5-6, so the engine
 * resends the whole history instead (see engine.ts).
 */
export function continuesInPlace(entry: ContinuationEntry): boolean {
  return entry.persisted || !/-wm$/i.test(entry.model);
}

export interface ContinuationHit {
  entry: ContinuationEntry;
  /** the messages the backend has not seen yet */
  newMessages: OpenAIMessage[];
}

const TTL_MS = 25 * 60_000;
const MAX_ENTRIES = 400;
const MAX_NEW_MESSAGES = 8;
// gateway-added suffixes move from turn to turn and must not take part in the key
const REMINDER = /\n\n\[(?:Harness reminder|Output format|ShadowGate usage):[\s\S]*?\]\s*$/;

const entries = new Map<string, ContinuationEntry>();

// ── persistence: the cache survives a restart, so a deploy does not force a full resend per conversation ──
let file: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

export function initContinuationStore(path: string): void {
  file = path;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as { entries?: Array<[string, ContinuationEntry]> };
    const now = Date.now();
    let loaded = 0;
    for (const [k, e] of parsed.entries ?? []) {
      if (!e || typeof e.conversationId !== 'string' || now - e.lastUsed > TTL_MS) continue;
      entries.set(k, e);
      loaded++;
    }
    if (loaded) console.log(`[continuation] restored ${loaded} live conversation link(s)`);
  } catch {
    /* no file yet, or unreadable — start empty */
  }
}

function scheduleSave(): void {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500);
  saveTimer.unref?.();
}

export function saveNow(): void {
  if (!file) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: [...entries.entries()] }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[continuation] could not save the cache:', (err as Error).message);
  }
}

function canon(m: OpenAIMessage): string {
  const c = m.content;
  if (typeof c === 'string') return `${m.role}\u0000${c.replace(REMINDER, '')}`;
  if (!Array.isArray(c)) return `${m.role}\u0000`;
  const parts = c.map((p) => {
    if (p.type === 'text') return `t:${(p.text ?? '').replace(REMINDER, '')}`;
    if (p.type === 'image_url') return `i:${crypto.createHash('sha256').update(p.image_url?.url ?? '').digest('hex').slice(0, 24)}`;
    return `${p.type}:`;
  });
  return `${m.role}\u0000${parts.join('\u0001')}`;
}

/** Hash of a full message list under a requested model + effort. */
export function historyKey(messages: OpenAIMessage[], model: string, effort: string | undefined): string {
  const h = crypto.createHash('sha256');
  h.update(`${model}\u0002${effort ?? ''}\u0003`);
  for (const m of messages) { h.update(canon(m)); h.update('\u0004'); }
  return h.digest('hex');
}

/**
 * Find the longest known prefix: messages[0..j) hashed to an entry, messages[j]
 * is the assistant turn the backend already holds, messages[j+1..] are the
 * new user/tool messages to send.
 */
export function findContinuation(messages: OpenAIMessage[], model: string, effort: string | undefined): ContinuationHit | null {
  const now = Date.now();
  const n = messages.length;
  for (let j = n - 2; j >= 1 && j >= n - 1 - MAX_NEW_MESSAGES; j--) {
    if (messages[j].role !== 'assistant') continue;
    const tail = messages.slice(j + 1);
    if (!tail.length || tail.some((m) => m.role !== 'user' && m.role !== 'tool')) continue;
    const entry = entries.get(historyKey(messages.slice(0, j), model, effort));
    if (!entry) continue;
    if (now - entry.lastUsed > TTL_MS) { entries.delete(historyKey(messages.slice(0, j), model, effort)); continue; }
    return { entry, newMessages: tail };
  }
  return null;
}

/** Remember that `messages` (the full list a request carried) now lives in this backend conversation. */
export function rememberContinuation(messages: OpenAIMessage[], model: string, effort: string | undefined, entry: Omit<ContinuationEntry, 'createdAt' | 'lastUsed' | 'turns'> & Partial<Pick<ContinuationEntry, 'createdAt' | 'turns'>>): void {
  const key = historyKey(messages, model, effort);
  const prev = entries.get(key);
  entries.delete(key); // re-insert at the end: Map keeps insertion order, which is our LRU order
  entries.set(key, { createdAt: entry.createdAt ?? prev?.createdAt ?? Date.now(), turns: (entry.turns ?? prev?.turns ?? 0) + 1, ...entry, lastUsed: Date.now() });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
  scheduleSave();
}

/** Drop every entry that points at a conversation (it broke, or the session went away). */
export function forgetConversation(conversationId: string): void {
  for (const [k, e] of entries) if (e.conversationId === conversationId) entries.delete(k);
  scheduleSave();
}

/** Remove expired entries and return the distinct persisted conversations that should now be hidden upstream. */
export function sweepExpired(now = Date.now()): ContinuationEntry[] {
  const out = new Map<string, ContinuationEntry>();
  for (const [k, e] of entries) {
    if (now - e.lastUsed <= TTL_MS) continue;
    entries.delete(k);
    if (e.persisted && !out.has(e.conversationId)) out.set(e.conversationId, e);
  }
  // a conversation still referenced by a live entry must not be hidden
  for (const e of entries.values()) out.delete(e.conversationId);
  if (out.size) scheduleSave();
  return [...out.values()];
}

/** Every persisted conversation currently known (for shutdown clean-up). */
export function allPersisted(): ContinuationEntry[] {
  const out = new Map<string, ContinuationEntry>();
  for (const e of entries.values()) if (e.persisted && !out.has(e.conversationId)) out.set(e.conversationId, e);
  return [...out.values()];
}

export function continuationStats(): { entries: number; persisted: number } {
  let persisted = 0;
  const seen = new Set<string>();
  for (const e of entries.values()) if (e.persisted && !seen.has(e.conversationId)) { seen.add(e.conversationId); persisted++; }
  return { entries: entries.size, persisted };
}

/** Test hook. */
export function _resetContinuation(): void {
  entries.clear();
  file = null;
}
