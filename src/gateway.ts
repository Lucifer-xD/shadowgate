// OpenAI-compatible public API: /v1/models + /v1/chat/completions.
import type { Express, Request, Response, NextFunction } from 'express';
import { Store, ApiKeyRecord, RequestLog } from './store.js';
import { Config } from './config.js';
import { TokenPool } from './pool.js';
import { nowIso, sha256hex, uuid } from './util.js';
import { countMessageTokens, countTokens } from './tokens.js';
import { runCompletion } from './engine.js';
import { ChatStore, recordApiExchange } from './chats.js';
import { continuesInPlace, findContinuation } from './continuation.js';
import { summarizeHistory } from './summarize.js';
import { NUDGE_EMPTY_MESSAGE, NUDGE_MESSAGE, ToolCallStream, admitsPartialResult, callKey, cappedHint, extractToolCalls, latestToolText, nudgeCappedMessage, injectToolPreamble, looksLikeShortAnnouncement, looksLikeUnfulfilledIntent, normalizeToolChoice, normalizeTools, toolPreamble, transformMessagesForTools, type ToolCall } from './tools.js';
import * as cg from './chatgpt/client.js';
import { lastUserAsksAboutUsage, usageNote, usageReport, usageText } from './usage.js';

// Measured 2026-10: chatgpt.com accepts ~400k characters per request in total (~120k tokens)
// and ~330k per single message; the latter is handled by splitting (client.ts).
const MAX_CHARS = 480_000;
const EFFECTIVE_CONTEXT_TOKENS = 120_000;
const HEARTBEAT_MS = 15_000;
/** Output cap we advertise; a harness reserves this out of the context window for the reply. */
const MAX_OUTPUT_TOKENS = 16_384;
/** tool mode: visible chars held back at the start of a streamed reply (see leadBuffer) */
const LEAD_HOLD = 300;

const openaiError = (res: Response, status: number, message: string, type = 'invalid_request_error') =>
  res.status(status).json({
    error: { message, type, param: null, code: null },
  });

// ── API-key auth + sliding-window rate limits ─────────────────────────────

const windows = new Map<string, number[]>();

function rateLimited(key: ApiKeyRecord): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  let hits = windows.get(key.id) ?? [];
  hits = hits.filter((t) => now - t < 24 * 3600_000);
  const lastMinute = hits.filter((t) => now - t < 60_000);
  if (lastMinute.length >= key.rpm) {
    windows.set(key.id, hits);
    return { limited: true, retryAfter: Math.max(1, Math.ceil((60_000 - (now - lastMinute[0])) / 1000)) };
  }
  if (hits.length >= key.rpd) {
    windows.set(key.id, hits);
    return { limited: true, retryAfter: Math.max(1, Math.ceil((24 * 3600_000 - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  windows.set(key.id, hits);
  return { limited: false };
}

/** Drop rate-limit state for keys that no longer exist (hourly). */
function pruneWindows(store: Store): void {
  const live = new Set(store.keys.map((k) => k.id));
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [id, hits] of windows) {
    if (!live.has(id) || hits.every((t) => t < cutoff)) windows.delete(id);
  }
}

function apiKeyAuth(store: Store, countHit: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('cache-control', 'no-store');
    const auth = req.headers.authorization || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!key.startsWith('sg-')) {
      openaiError(res, 401, 'Missing or malformed API key. Expected: Authorization: Bearer sg-...', 'authentication_error');
      return;
    }
    const hash = sha256hex(key);
    const rec = store.keys.find((k) => k.hash === hash);
    if (!rec) {
      openaiError(res, 401, 'Invalid API key.', 'authentication_error');
      return;
    }
    if (!rec.enabled) {
      openaiError(res, 403, 'This API key has been disabled.', 'permission_error');
      return;
    }
    if (countHit) {
      const rl = rateLimited(rec);
      if (rl.limited) {
        res.setHeader('retry-after', String(rl.retryAfter));
        openaiError(res, 429, `Rate limit reached for key ${rec.prefix}… (${rec.rpm} req/min, ${rec.rpd} req/day).`, 'rate_limit_error');
        return;
      }
    }
    (req as any).apiKey = rec;
    next();
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

interface ChatBody {
  model?: string;
  messages?: cg.OpenAIMessage[];
  stream?: boolean;
  /** OpenAI: minimal | low | medium | high (also accepts ChatGPT's standard | extended) */
  reasoning_effort?: string;
  /** Responses-API style { effort } is accepted too */
  reasoning?: { effort?: string };
  thinking_effort?: string;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
  tool_choice?: unknown;
  functions?: unknown[];
  function_call?: unknown;
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
}

const ALIAS_IDS = ['auto', 'astra', 'luna', 'sol', 'gpt-6', 'gpt-5', 'gpt-5-thinking', 'gpt-5-mini', 'gpt-5-pro', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'];

function modelList(pool: TokenPool) {
  const cat = pool.catalog();
  const created = 1735689600;
  // every row is listed: the bare GPT-6 slugs (chat lane) and the -wm work-mode slugs
  const real = cat.models.map((m) => {
    const reasons = m.efforts.length > 0 || m.reasoning === 'reasoning' || m.reasoning === 'pro';
    const efforts = cg.effortTable(m.efforts);
    const effortIds = Object.keys(efforts);
    // the model's real context window as chatgpt.com reports it; the per-request
    // character budget is enforced by the gateway (history compaction), not by this number
    const ctx = m.maxTokens ?? EFFECTIVE_CONTEXT_TOKENS;
    return {
    id: m.slug,
    object: 'model' as const,
    created,
    owned_by: 'chatgpt',
    // extras — harmless to OpenAI clients, useful to humans and to harnesses that read listings
    title: m.title,
    display_name: m.title,
    lane: m.reasoning,
    // reasoning capability, under the names different harnesses look for
    reasoning: reasons,
    supports_reasoning: reasons,
    reasoning_efforts: effortIds,               // OpenAI spellings accepted in reasoning_effort
    reasoning_effort_map: efforts,              // what each becomes upstream (standard / extended)
    thinking_efforts: m.efforts,                // ChatGPT's own values, also accepted
    default_reasoning_effort: reasons ? 'medium' : undefined,
    capabilities: { tools: true, function_calling: true, streaming: true, json_mode: true, reasoning: reasons, vision: true },
    input_modalities: ['text', 'image'],
    input: ['text', 'image'],
    output_modalities: ['text'],
    supports_vision: true,
    supports_function_calling: true,
    supports_tools: true,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    limit: { context: ctx, output: MAX_OUTPUT_TOKENS },
    // context size under the names clients look for (max_tokens alone is read as an output cap by some)
    // the backend's per-request budget is smaller than the model's context — report what actually fits
    context_length: ctx,
    context_window: ctx,
    max_input_tokens: ctx,
    // what one request can carry before the gateway compacts the history (≈480k characters)
    request_budget_tokens: EFFECTIVE_CONTEXT_TOKENS,
    // the slug sent to chatgpt.com (work-mode models need their -wm form plus a work-mode conversation)
    upstream_slug: m.upstreamSlug ?? m.slug,
    work_mode: !!m.workMode,
    direct: !!m.direct,
    lane_note: m.workMode ? 'work-mode conversation; continuation keeps the chat saved in the account while active' : m.direct ? 'chat lane; the backend echoes the slug; continues inside temporary chats' : undefined,
  };
  });
  // aliases (auto, gpt-5, o3, astra …) keep resolving but are not listed: one row per real model
  return { cat, data: real };
}

/** "gpt-6-astra-wm" → "gpt-6-astra": the name the listing uses for a work-mode model. */
const cleanName = (slug: string) => slug.replace(/-wm$/i, '');

/** A listing row for an alias looked up by name (GET /v1/models/{alias}). */
function aliasRow(id: string, pool: TokenPool) {
  const cat = pool.catalog();
  const target = cleanName(cg.resolveModel(id, undefined, cat).slug);
  return { id, object: 'model' as const, created: 1735689600, owned_by: 'shadowgate', alias_of: target };
}

function finishRequest(
  store: Store,
  key: ApiKeyRecord,
  body: ChatBody,
  status: number,
  started: number,
  charsIn: number,
  charsOut: number,
  error?: string,
  notes?: string[],
): void {
  key.totalRequests++;
  key.totalChars += charsIn + charsOut;
  key.lastUsed = nowIso();
  const entry: RequestLog = {
    ts: nowIso(),
    keyId: key.id,
    model: typeof body?.model === 'string' && body.model ? body.model.slice(0, 60) : 'auto',
    stream: !!body?.stream,
    status,
    latencyMs: Date.now() - started,
    charsIn,
    charsOut,
    error: error?.slice(0, 200),
    ...(notes && notes.length ? { notes: notes.join(' · ').slice(0, 200) } : {}),
  };
  store.logRequest(entry);
}

const TRUNC = (n: number) => `\n…[${n} characters truncated by the gateway to fit the backend's budget]…\n`;

/** Characters the backend will see: text only — images go up as files, not as text. */
export function textSize(messages: cg.OpenAIMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += 40; // envelope
    const c = m.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) for (const p of c) n += p.type === 'text' && p.text ? p.text.length : 60;
  }
  return n;
}

/** Replace the text of a message, keeping any image parts it carries. */
/** Append a note to a message's text (the last text part of a multi-part message). */
function appendText(m: cg.OpenAIMessage, note: string): cg.OpenAIMessage {
  if (!Array.isArray(m.content)) return { ...m, content: `${m.content ?? ''}${note}` };
  const parts = m.content.map((p) => ({ ...p }));
  const i = parts.map((p) => p.type).lastIndexOf('text');
  if (i === -1) parts.push({ type: 'text', text: note.trim() });
  else parts[i] = { ...parts[i], text: `${parts[i].text ?? ''}${note}` };
  return { ...m, content: parts };
}


function withText(m: cg.OpenAIMessage, text: string): cg.OpenAIMessage {
  if (!Array.isArray(m.content)) return { ...m, content: text };
  const images = m.content.filter((p) => p.type !== 'text');
  return { ...m, content: [...images, { type: 'text', text }] };
}

/** Shorten a long text keeping its head and tail. */
function clip(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = Math.floor(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + TRUNC(text.length - keep) + text.slice(text.length - tail);
}

/**
 * Bring a conversation under `budget` characters the way an agent harness
 * would: (1) shrink older tool results and assistant turns, (2) drop the
 * oldest turns after the first user message, (3) clip what is left, the
 * latest message included, head and tail kept around a marker.
 * The first system prompt, the first user message and the last two
 * messages are the last to be touched.
 */
export function compactHistory(input: cg.OpenAIMessage[], budget: number): cg.OpenAIMessage[] {
  const msgs = input.map((m) => ({ ...m }));
  const size = () => textSize(msgs);
  const textOf = (c: cg.OpenAIMessage['content']): string => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n') : '';
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  const protectedIdx = new Set<number>([firstUser, msgs.length - 1, msgs.length - 2].filter((i) => i >= 0));
  // pass 1: clip old tool / assistant / user bodies, oldest first, down to 4k chars each
  for (let i = 0; i < msgs.length && size() > budget; i++) {
    if (protectedIdx.has(i) || msgs[i].role === 'system') continue;
    const t = textOf(msgs[i].content);
    if (t.length > 4000) msgs[i] = withText(msgs[i], clip(t, 4000));
  }
  // pass 2: drop the oldest non-protected turns entirely
  while (size() > budget) {
    const i = msgs.findIndex((m, idx) => !protectedIdx.has(idx) && m.role !== 'system');
    if (i === -1) break;
    msgs.splice(i, 1);
    // indices shifted — recompute protected set
    const fu = msgs.findIndex((m) => m.role === 'user');
    protectedIdx.clear();
    for (const k of [fu, msgs.length - 1, msgs.length - 2]) if (k >= 0) protectedIdx.add(k);
  }
  // pass 3: clip the remaining messages (latest included) proportionally
  if (size() > budget) {
    const over = size() - budget;
    const order = [...msgs.keys()].sort((a, b) => textOf(msgs[b].content).length - textOf(msgs[a].content).length);
    for (const i of order) {
      if (size() <= budget) break;
      const t = textOf(msgs[i].content);
      const keep = Math.max(2000, t.length - over - 256); // marker + JSON escaping headroom
      if (t.length > keep) msgs[i] = withText(msgs[i], clip(t, keep));
    }
  }
  return msgs;
}

function validateMessages(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return "'messages' must be a non-empty array.";
  for (const m of messages) {
    if (!m || typeof m !== 'object') return 'Each message must be an object.';
    if (!['system', 'user', 'assistant', 'tool', 'developer'].includes((m as any).role)) {
      return "Each message needs a valid 'role' (system|developer|user|assistant|tool).";
    }
    const c = (m as any).content;
    if (typeof c !== 'string' && !Array.isArray(c) && c !== null && c !== undefined) {
      return "'content' must be a string or an array of content parts.";
    }
    if ((m as any).role === 'tool' && typeof (m as any).tool_call_id !== 'string' && typeof (m as any).name !== 'string') {
      return "tool messages need a 'tool_call_id'.";
    }
  }
  return null;
}

// ── routes ───────────────────────────────────────────────────────────────

export function mountGateway(app: Express, store: Store, cfg: Config, pool: TokenPool, chats: ChatStore): void {
  setInterval(() => pruneWindows(store), 3600_000).unref();

  // CORS — bearer auth only (no cookies) so a wildcard origin is safe and
  // lets browser-based OpenAI clients talk to the gateway.
  app.use('/v1', (req, res, next) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, openai-organization, openai-project, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count, x-stainless-timeout');
    res.setHeader('access-control-expose-headers', 'x-shadowgate-model, x-shadowgate-served, retry-after');
    res.setHeader('access-control-max-age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/v1/models', apiKeyAuth(store, false), (_req, res) => {
    const { cat, data } = modelList(pool);
    res.json({ object: 'list', data, default_model: cat.defaultModel });
  });
  app.get('/v1/models/:id', apiKeyAuth(store, false), (req, res) => {
    const id = String(req.params.id);
    const { data } = modelList(pool);
    const hit = data.find((m) => m.id === id) ?? (ALIAS_IDS.includes(id.toLowerCase()) || /^(gpt-|o[134]|astra|luna|sol|terra)/i.test(id) ? aliasRow(id, pool) : undefined);
    if (!hit) {
      openaiError(res, 404, `The model '${id}' does not exist.`, 'invalid_request_error');
      return;
    }
    res.json(hit);
  });

  // the ChatGPT account limits (5-hour / weekly windows, credits) + this key's own gateway usage
  app.get('/v1/usage', apiKeyAuth(store, false), async (req, res) => {
    const key = (req as any).apiKey as ApiKeyRecord;
    await pool.refreshAllUsage().catch(() => {});
    const report = usageReport(store, key);
    if (String(req.query.format ?? '') === 'text') {
      res.type('text/plain; charset=utf-8').send(usageText(report));
      return;
    }
    res.json(report);
  });

  app.post('/v1/chat/completions', apiKeyAuth(store, true), async (req, res) => {
    const key = (req as any).apiKey as ApiKeyRecord;
    const started = Date.now();
    const body = (req.body ?? {}) as ChatBody;
    const notes: string[] = [];

    // validation
    const invalid = validateMessages(body.messages);
    if (invalid) {
      finishRequest(store, key, body, 400, started, 0, 0, invalid);
      openaiError(res, 400, invalid);
      return;
    }
    let messages = (body.messages as Array<cg.OpenAIMessage | { role: 'developer'; content: cg.OpenAIMessage['content'] }>).map((m): cg.OpenAIMessage =>
      m.role === 'developer' ? { ...m, role: 'system' } : (m as cg.OpenAIMessage),
    );
    // emulated function calling: describe the client's tools, round-trip earlier calls/results as text
    const toolChoice = normalizeToolChoice(body);
    const tools = toolChoice === 'none' ? [] : normalizeTools(body);
    const toolMode = tools.length > 0;
    if (toolMode || messages.some((m) => m.role === 'tool' || (m as any).tool_calls)) {
      messages = transformMessagesForTools(messages);
    }
    if (toolMode) messages = injectToolPreamble(messages, toolPreamble(tools, toolChoice), tools);
    if (toolMode) notes.push(`tools ${tools.length}`);
    // "what's my usage?" from any client: attach the live numbers so the model answers from real data
    // The question is read from the client's last real user message, so in an agent loop
    // ("do X, then tell me my usage") every later tool round gets fresh numbers too.
    // (attached to the last user-role message even when the harness adds a system note after it)
    const lastIdx = messages.map((m) => m.role).lastIndexOf('user');
    if (lastIdx >= 0 && messages.slice(lastIdx + 1).every((m) => m.role === 'system') && lastUserAsksAboutUsage(body.messages as cg.OpenAIMessage[])) {
      await pool.refreshAllUsage().catch(() => {});
      messages[lastIdx] = appendText(messages[lastIdx], usageNote(usageText(usageReport(store, key))));
      notes.push('usage attached');
    }
    // response_format: ask for bare JSON (and strip fences afterwards)
    const rf = body.response_format;
    const jsonMode = rf?.type === 'json_object' || rf?.type === 'json_schema';
    if (jsonMode) {
      const schema = rf?.type === 'json_schema' && rf.json_schema?.schema ? `\nIt must match this JSON Schema:\n${JSON.stringify(rf.json_schema.schema).slice(0, 20000)}` : '';
      const li = messages.map((m) => m.role).lastIndexOf('user');
      const note = `\n\n[Output format: respond with a single valid JSON object and nothing else — no prose, no markdown fence.${schema}]`;
      if (li === -1) messages.push({ role: 'user', content: note.trim() });
      else messages[li] = { role: 'user', content: `${typeof messages[li].content === 'string' ? messages[li].content : ''}${note}` };
    }
    const stops = (Array.isArray(body.stop) ? body.stop : typeof body.stop === 'string' ? [body.stop] : []).filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 4);
    const maxOut = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : typeof body.max_tokens === 'number' ? body.max_tokens : 0;
    const maxOutChars = maxOut > 0 ? maxOut * 4 : 0; // ~4 chars per token
    const stripFence = (t: string) => t.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const model = typeof body.model === 'string' && body.model ? body.model : 'auto';
    const effortReq =
      typeof body.reasoning_effort === 'string' ? body.reasoning_effort :
      typeof body.reasoning?.effort === 'string' ? body.reasoning.effort :
      typeof body.thinking_effort === 'string' ? body.thinking_effort : undefined;
    let totalChars = textSize(messages);
    // a continuation sends only the new messages upstream, so only those must fit the per-request budget —
    // but a temporary work-mode chat is never continued (the engine resends everything), so there the whole history counts
    const found = (store.settings.continuation ?? 'temp') !== 'off' ? findContinuation(messages, model, effortReq) : null;
    const hit = found && continuesInPlace(found.entry) ? found : null;
    const upstreamChars = hit ? textSize(hit.newMessages) : totalChars;
    if (upstreamChars > MAX_CHARS) {
      // Harnesses that never compact would die here with a 413. Compact for them:
      // old tool outputs first, then old turns — never the system prompt or the latest exchange.
      const before = totalChars;
      if (hit) notes.push('new messages over budget → full compaction');
      // first choice: condense the middle of the conversation with a fast model, keeping every detail that matters
      const summarised = await summarizeHistory(pool, store, messages, MAX_CHARS).catch(() => null);
      if (summarised) {
        messages = summarised.messages;
        notes.push(`summarised ${summarised.summarised} msgs`);
        console.log(`[gateway] summarised ${summarised.summarised} earlier messages for key ${key.name}`);
      }
      // then clip whatever is still over budget (also the fallback when the summariser is unavailable)
      if (textSize(messages) > MAX_CHARS) messages = compactHistory(messages, MAX_CHARS);
      totalChars = textSize(messages);
      if (totalChars > MAX_CHARS) {
        finishRequest(store, key, body, 413, started, totalChars, 0, 'too large');
        openaiError(res, 413, `Request too large even after compaction: ${Math.round(totalChars / 1000)}k characters, but ChatGPT's backend accepts about ${MAX_CHARS / 1000}k per request (~${EFFECTIVE_CONTEXT_TOKENS / 1000}k tokens). The latest message alone is over budget — send it in parts.`);
        return;
      }
      res.setHeader('x-shadowgate-compacted', `${before}->${totalChars}`);
      notes.push(`compacted ${Math.round(before / 1000)}k→${Math.round(totalChars / 1000)}k`);
      console.warn(`[gateway] compacted history ${before} -> ${totalChars} chars for key ${key.name}`);
    }
    const stream = !!body.stream;
    // exact o200k token counts: the whole prompt, and the part the backend already held on a continued request
    let promptTokensMemo: number | undefined;
    const promptTokens = () => (promptTokensMemo ??= countMessageTokens(messages));
    const cachedTokens = () => (result?.continued && hit ? Math.max(0, promptTokens() - countMessageTokens(hit.newMessages)) : 0);
    let servedModel = model; // replaced by the slug the backend reports
    const completionId = `chatcmpl-${uuid().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: servedModel,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;

    // abort the upstream conversation if the client goes away (saves quota)
    const clientAbort = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) clientAbort.abort();
    });

    let streamStarted = false;
    let toolStream = toolMode ? new ToolCallStream() : null;
    let holdStream = false;
    // tool mode: the first LEAD_HOLD visible chars are held back until the turn ends, so a bare
    // announcement, refusal or empty-turn note that a nudge replaces never reaches the client
    let leadBuffer = '';
    let leadReleased = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let outChars = 0; // visible chars delivered so far (stop / max_tokens accounting)
    let jsonBuffer = ''; // json-mode streams are delivered whole so fences can be stripped
    res.on('close', () => { if (heartbeat) clearInterval(heartbeat); });
    const runOnce = (msgs: cg.OpenAIMessage[]) => runCompletion({
      pool,
      store,
      messages: msgs,
      model,
      effort: effortReq,
      signal: clientAbort.signal,
      onModel: (slug, effort) => {
        // the client sees the clean name ("gpt-6-astra"); the header keeps the exact upstream slug
        servedModel = cleanName(slug);
        if (!res.headersSent) res.setHeader('x-shadowgate-model', slug + (effort ? `;thinking_effort=${effort}` : ''));
      },
      onServed: (s) => {
        // the lane that really answered: "chat" (the chat lane) or "work" (the real work-mode family)
        const value = [s.experience && `experience=${s.experience}`, s.harness && `harness=${s.harness}`, s.slug && `slug=${s.slug}`].filter(Boolean).join('; ');
        if (value && !res.headersSent) res.setHeader('x-shadowgate-served', value);
        const note = `served ${s.experience ?? '?'}/${s.harness ?? '?'}`;
        if (!notes.includes(note)) notes.push(note);
      },
      onStart: () => {
        if (stream && !streamStarted) {
          streamStarted = true;
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write(chunk({ role: 'assistant', content: '' }, null));
          // SSE comment lines keep Cloudflare/nginx from dropping an idle connection while the model thinks
          heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, HEARTBEAT_MS);
        }
      },
      onDelta: (text) => {
        // stop sequences and max_tokens apply to the visible text in every mode
        let piece = text;
        let verdict: void | 'stop' | 'length' = undefined;
        if (stops.length) {
          const joined = outChars ? piece : piece; // scan this piece (stop strings rarely straddle chunks)
          let cutAt = -1;
          for (const sq of stops) { const k = joined.indexOf(sq); if (k !== -1 && (cutAt === -1 || k < cutAt)) cutAt = k; }
          if (cutAt !== -1) { piece = piece.slice(0, cutAt); verdict = 'stop'; }
        }
        if (maxOutChars && outChars + piece.length >= maxOutChars) { piece = piece.slice(0, Math.max(0, maxOutChars - outChars)); verdict = 'length'; }
        outChars += piece.length;
        if (!stream) return verdict;
        if (jsonMode) { jsonBuffer += piece; return verdict; }
        if (toolStream) {
          const safe = toolStream.push(piece);
          // during a nudged re-run the text is held until we know whether it produced calls
          if (!safe || holdStream) return verdict;
          if (!leadReleased && !toolStream.sawCall && leadBuffer.length + safe.length < LEAD_HOLD) { leadBuffer += safe; return verdict; }
          if (!leadReleased) { leadReleased = true; if (leadBuffer) { res.write(chunk({ content: leadBuffer }, null)); leadBuffer = ''; } }
          res.write(chunk({ content: safe }, null));
        } else if (piece) {
          res.write(chunk({ content: piece }, null));
        }
        return verdict;
      },
      onReasoning: (text) => {
        if (stream) res.write(chunk({ reasoning_content: text }, null));
      },
      onNote: (n) => notes.push(n),
      onContinue: (n) => { if (!res.headersSent) res.setHeader('x-shadowgate-continued', String(n)); },
    });

    let result = await runOnce(messages);
    // ChatGPT's own size limit varies (~400–590k characters per request); if it still says "too long",
    // condense to 70% and try once more before the client has seen anything
    if (!result.ok && !result.aborted && !streamStarted && /message_length_exceeds_limit|messages you submitted were too long/i.test(result.error ?? '')) {
      const before = textSize(messages);
      const target = Math.floor(Math.min(before, MAX_CHARS) * 0.7);
      let smaller = (await summarizeHistory(pool, store, messages, target).catch(() => null))?.messages ?? messages;
      if (textSize(smaller) > target) smaller = compactHistory(smaller, target);
      if (textSize(smaller) < before) {
        messages = smaller;
        totalChars = textSize(messages);
        notes.push(`ChatGPT said too long → compacted ${Math.round(before / 1000)}k→${Math.round(totalChars / 1000)}k, retried`);
        console.warn(`[gateway] upstream 413 (too long) at ${before} chars — compacted to ${totalChars} and retrying once`);
        if (!res.headersSent) res.setHeader('x-shadowgate-compacted', `${before}->${totalChars}`);
        result = await runOnce(messages);
      }
    }
    // did the model ask for tools?
    let calls: ToolCall[] = [];
    let visibleText = result.text;
    let unsent = ''; // streaming: visible text the client has not received yet
    let announced = ''; // text already streamed before a nudge
    const parseTools = () => {
      if (!toolMode) return;
      if (stream && toolStream) {
        const parsed = toolStream.finish();
        calls = parsed.calls; visibleText = parsed.text; unsent = leadBuffer + parsed.unsent; leadBuffer = '';
      } else {
        const parsed = extractToolCalls(result.text);
        calls = parsed.calls; visibleText = parsed.text;
      }
    };
    parseTools();
    // mid-loop (last message was a tool result) a short reply with no block is almost
    // always an announcement ("I'll retry with -Path.") — nudge regardless of wording
    const midLoop = (body.messages as any[]).at(-1)?.role === 'tool';
    const shortMidLoop = midLoop && looksLikeShortAnnouncement(visibleText);
    const intent = looksLikeUnfulfilledIntent(visibleText);
    // the tool paged its output ("Use offset=1547 to continue.") and the reply stops at that page
    const capped = midLoop ? cappedHint(latestToolText(body.messages as any[])) : undefined;
    const cappedStop = !!capped && admitsPartialResult(visibleText);
    // every call the conversation has already executed — a nudge must never replay one of them
    const priorCalls = new Set<string>();
    for (const m of body.messages as any[]) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) priorCalls.add(callKey(c?.function?.name ?? '', c?.function?.arguments));
    }
    const repeatsPriorCall = () => calls.length > 0 && calls.every((c) => priorCalls.has(callKey(c.name, c.arguments)));
    if (toolMode && result.ok && !calls.length && !clientAbort.signal.aborted && (intent || shortMidLoop || cappedStop)) {
      // "I need to check your PC." with no block → ask once for the block itself
      const why = cappedStop ? 'capped output' : intent ? 'announcement' : 'short mid-loop';
      console.warn(`[gateway] tool mode: block-less reply (${why}) — nudging once`);
      notes.push(`nudged (${why})`);
      announced = visibleText;
      const firstUnsent = unsent; // held-back lead text of the first run (nothing was written yet)
      const emptyTurn = announced.trim().startsWith('[shadowgate:');
      const firstResult = result;
      toolStream = toolMode ? new ToolCallStream() : null;
      holdStream = true;
      result = await runOnce([...messages, { role: 'assistant', content: emptyTurn ? '' : result.text }, { role: 'user', content: emptyTurn ? NUDGE_EMPTY_MESSAGE : cappedStop && capped ? nudgeCappedMessage(capped) : NUDGE_MESSAGE }]);
      holdStream = false;
      parseTools();
      if (repeatsPriorCall()) {
        // the nudge only made it redo an action it already did — the short reply was the real answer
        console.warn('[gateway] tool mode: nudge produced a repeat of an earlier call — keeping the original reply');
        notes.push('nudge repeated a call → kept reply');
        calls = [];
        result = firstResult;
        visibleText = announced;
        unsent = firstUnsent;
      } else if (!calls.length && (!intent || cappedStop)) {
        // it really was the final answer (or it would not page on) — keep the original, drop the restatement
        result = firstResult;
        visibleText = announced;
        unsent = firstUnsent;
      } else if (!calls.length) {
        // the announcement was empty talk; the re-run holds the real answer
        if (stream) unsent = visibleText;
        else visibleText = emptyTurn ? visibleText : `${announced}\n\n${visibleText}`.trim();
      } else {
        unsent = ''; // calls follow; the announcement and any lead-in text of the re-run are dropped
      }
    }
    finished = true;

    if (result.aborted) {
      finishRequest(store, key, body, 499, started, totalChars, result.text.length, 'client disconnected');
      return;
    }

    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (result.ok) {
      const finish = calls.length ? 'tool_calls' : result.finish;
      if (calls.length) notes.push(`${calls.length} tool call${calls.length > 1 ? 's' : ''}`);
      if (jsonMode) {
        if (stream) res.write(chunk({ content: stripFence(jsonBuffer) }, null));
        else result = { ...result, text: stripFence(result.text) };
      }
      if (stream) {
        if (toolStream && unsent) res.write(chunk({ content: unsent }, null));
        calls.forEach((c, i) => {
          res.write(chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }, null));
          res.write(chunk({ tool_calls: [{ index: i, function: { arguments: c.arguments } }] }, null));
        });
        if (result.interrupted) res.write(chunk({ content: `\n[shadowgate: stream interrupted — ${result.interrupted}]` }, null));
        res.write(chunk({}, finish));
        if (body.stream_options?.include_usage) {
          res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: servedModel, choices: [], usage: {
            prompt_tokens: promptTokens(), completion_tokens: countTokens(result.text), total_tokens: promptTokens() + countTokens(result.text),
            prompt_tokens_details: { cached_tokens: cachedTokens() }, cached_tokens: cachedTokens(),
          } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        let finalText = calls.length ? (visibleText || '') : result.text;
        if (stops.length) for (const sq of stops) { const k = finalText.indexOf(sq); if (k !== -1) finalText = finalText.slice(0, k); }
        if (maxOutChars && finalText.length > maxOutChars) finalText = finalText.slice(0, maxOutChars);
        res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model: servedModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: calls.length ? (finalText || null) : finalText,
              ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            },
            finish_reason: finish,
          }],
          usage: {
            prompt_tokens: promptTokens(),
            completion_tokens: countTokens(result.text),
            total_tokens: promptTokens() + countTokens(result.text),
            prompt_tokens_details: { cached_tokens: cachedTokens() },
            cached_tokens: cachedTokens(),
          },
        });
      }
      finishRequest(store, key, body, 200, started, totalChars, result.text.length, result.interrupted, notes);
      if (store.settings.recordApi) {
        try { recordApiExchange(chats, key.name, model, messages, result); } catch (err) { console.warn('[gateway] record failed:', (err as Error).message); }
      }
      return;
    }

    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    const type =
      result.status === 429 ? 'rate_limit_error' :
      result.status === 503 ? 'service_unavailable' : 'upstream_error';
    finishRequest(store, key, body, result.status, started, totalChars, 0, result.error, notes);
    if (!res.headersSent) {
      // Cloudflare replaces an origin 502/504 with its own error page, which would hide the message — send 503 instead
      const httpStatus = result.status === 502 || result.status === 504 ? 503 : result.status;
      openaiError(res, httpStatus, result.error ?? 'Unknown upstream error', type);
    } else {
      // stream already open — finish it cleanly so clients don't hang
      res.write(chunk({ content: `\n[shadowgate: ${result.error}]`.slice(0, 500) }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
}
