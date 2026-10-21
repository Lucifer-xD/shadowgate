// Built-in chat: conversations stored on disk, sidebar + streaming replies in
// the console. Also records /v1 traffic when the operator turns that on.
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { nowIso, uuid } from './util.js';
import type { OpenAIMessage } from './chatgpt/client.js';
import { runCompletion, type CompletionResult } from './engine.js';
import type { TokenPool } from './pool.js';
import type { Store } from './store.js';
import { asksAboutUsage, usageNote, usageReport, usageText } from './usage.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string;
  model?: string; // slug that answered (assistant)
  effort?: string;
  reasoning?: string; // thought summaries shown while thinking
  latencyMs?: number;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  model: string; // requested model / alias
  effort?: string;
  source: 'console' | 'api';
  keyName?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

const MAX_CONVERSATIONS = 1000;
const MAX_MESSAGES = 400;
const DEBOUNCE_MS = 300;

export class ChatStore {
  private file: string;
  private data: { conversations: Conversation[] };
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'chats.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { conversations: Array.isArray(parsed?.conversations) ? parsed.conversations : [] };
    } catch {
      this.data = { conversations: [] };
    }
  }

  get conversations(): Conversation[] {
    return this.data.conversations;
  }

  find(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  create(init: Partial<Conversation> & Pick<Conversation, 'model' | 'source'>): Conversation {
    const c: Conversation = {
      id: uuid(),
      title: init.title?.trim().slice(0, 80) || 'New chat',
      model: init.model || 'auto',
      effort: init.effort,
      source: init.source,
      keyName: init.keyName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: init.messages ?? [],
    };
    this.data.conversations.unshift(c);
    if (this.data.conversations.length > MAX_CONVERSATIONS) this.data.conversations.length = MAX_CONVERSATIONS;
    this.flush();
    return c;
  }

  remove(id: string): boolean {
    const i = this.data.conversations.findIndex((c) => c.id === id);
    if (i === -1) return false;
    this.data.conversations.splice(i, 1);
    this.flush();
    return true;
  }

  touch(c: Conversation): void {
    c.updatedAt = nowIso();
    if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
    // keep most recently used on top
    const i = this.data.conversations.indexOf(c);
    if (i > 0) {
      this.data.conversations.splice(i, 1);
      this.data.conversations.unshift(c);
    }
    this.flush();
  }

  flush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error('[shadowgate] chats flush failed:', err);
    }
  }
}

export const titleFrom = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return (t.length > 60 ? `${t.slice(0, 57)}…` : t) || 'New chat';
};

const summary = (c: Conversation) => ({
  id: c.id,
  title: c.title,
  model: c.model,
  effort: c.effort,
  source: c.source,
  keyName: c.keyName,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  count: c.messages.length,
  last: c.messages.length ? c.messages[c.messages.length - 1].content.slice(0, 90) : '',
});

/** Record a finished /v1 exchange as a read-only conversation. */
export function recordApiExchange(
  chats: ChatStore,
  keyName: string,
  requestedModel: string,
  messages: OpenAIMessage[],
  result: CompletionResult,
): void {
  const textOf = (m: OpenAIMessage): string =>
    typeof m.content === 'string' ? m.content :
    Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n') : '';
  const firstUser = messages.find((m) => m.role === 'user');
  const conv = chats.create({
    title: titleFrom(firstUser ? textOf(firstUser) : 'API request'),
    model: requestedModel,
    source: 'api',
    keyName,
    messages: messages.map((m) => ({ id: uuid(), role: m.role === 'tool' ? 'user' : m.role, content: textOf(m), ts: nowIso() })),
  });
  conv.messages.push({
    id: uuid(),
    role: 'assistant',
    content: result.text,
    ts: nowIso(),
    model: result.servedModel,
    effort: result.effort,
    latencyMs: result.latencyMs,
    error: result.error,
  });
  chats.touch(conv);
}

// ── routes (mounted behind the admin auth middleware) ─────────────────────

export function mountChats(
  app: Express,
  auth: (req: Request, res: Response, next: () => void) => void,
  chats: ChatStore,
  store: Store,
  pool: TokenPool,
): void {
  app.get('/api/admin/chats', auth, (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    let items = chats.conversations;
    if (q) items = items.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
    res.json({ items: items.slice(0, 300).map(summary), total: items.length });
  });

  app.post('/api/admin/chats', auth, (req, res) => {
    const { model, effort, title } = req.body ?? {};
    const c = chats.create({
      source: 'console',
      model: typeof model === 'string' && model ? model.slice(0, 60) : 'auto',
      effort: typeof effort === 'string' && effort ? effort.slice(0, 20) : undefined,
      title: typeof title === 'string' ? title : undefined,
    });
    res.json({ ok: true, conversation: c });
  });

  app.get('/api/admin/chats/:id', auth, (req, res) => {
    const c = chats.find(String(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ conversation: c });
  });

  app.patch('/api/admin/chats/:id', auth, (req, res) => {
    const c = chats.find(String(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { title, model, effort } = req.body ?? {};
    if (typeof title === 'string' && title.trim()) c.title = title.trim().slice(0, 80);
    if (typeof model === 'string' && model) c.model = model.slice(0, 60);
    if (effort === null || effort === '') c.effort = undefined;
    else if (typeof effort === 'string') c.effort = effort.slice(0, 20);
    chats.flush();
    res.json({ ok: true, conversation: c });
  });

  app.delete('/api/admin/chats/:id', auth, (req, res) => {
    if (!chats.remove(String(req.params.id))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.delete('/api/admin/chats/:id/messages/:mid', auth, (req, res) => {
    const c = chats.find(String(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const i = c.messages.findIndex((m) => m.id === String(req.params.mid));
    if (i === -1) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // drop the message and everything after it (keeps the transcript coherent)
    c.messages.splice(i);
    chats.touch(c);
    res.json({ ok: true, conversation: c });
  });

  /**
   * Send a user message and stream the reply as SSE:
   *   data: {"type":"user","message":{…}}
   *   data: {"type":"model","model":"gpt-5-6-thinking","effort":"extended"}
   *   data: {"type":"delta","text":"…"}
   *   data: {"type":"done","message":{…}}
   *   data: {"type":"error","message":"…"}
   */
  app.post('/api/admin/chats/:id/messages', auth, async (req, res) => {
    const c = chats.find(String(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { content, model, effort } = req.body ?? {};
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    if (typeof model === 'string' && model) c.model = model.slice(0, 60);
    if (typeof effort === 'string') c.effort = effort || undefined;

    const userMsg: ChatMessage = { id: uuid(), role: 'user', content: content.trim().slice(0, 200_000), ts: nowIso() };
    c.messages.push(userMsg);
    if (c.title === 'New chat') c.title = titleFrom(userMsg.content);
    chats.touch(c);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (ev: object) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    send({ type: 'user', message: userMsg });
    const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 15_000);

    const abort = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) abort.abort(); });

    const history: OpenAIMessage[] = c.messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    // same as /v1: a usage question gets the live numbers attached (not stored in the chat)
    const last = history[history.length - 1];
    if (last?.role === 'user' && typeof last.content === 'string' && asksAboutUsage(last.content)) {
      await pool.refreshAllUsage().catch(() => {});
      history[history.length - 1] = { ...last, content: last.content + usageNote(usageText(usageReport(store))) };
    }

    const result = await runCompletion({
      pool,
      store,
      messages: history,
      model: c.model,
      effort: c.effort,
      signal: abort.signal,
      onModel: (m, e) => send({ type: 'model', model: m, effort: e }),
      onDelta: (t) => { send({ type: 'delta', text: t }); },
      onReasoning: (t) => send({ type: 'reasoning', text: t }),
    });
    finished = true;
    clearInterval(heartbeat);

    const reply: ChatMessage = {
      id: uuid(),
      role: 'assistant',
      content: result.text,
      ts: nowIso(),
      model: result.servedModel,
      effort: result.effort,
      reasoning: result.reasoning,
      latencyMs: result.latencyMs,
      error: result.error,
    };
    c.messages.push(reply);
    chats.touch(c);
    if (result.error && !result.text) send({ type: 'error', message: result.error, status: result.status });
    send({ type: 'done', message: reply, conversation: summary(c) });
    res.end();
  });
}
