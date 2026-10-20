// Shared completion engine: pick a session, resolve the model, open the
// conversation, stream deltas, retry across sessions. Used by the OpenAI
// gateway (/v1) and the console chat.
import type { Store } from './store.js';
import type { TokenPool } from './pool.js';
import * as cg from './chatgpt/client.js';
import { findContinuation, forgetConversation, rememberContinuation, type ContinuationHit } from './continuation.js';

const MAX_ATTEMPTS = 3;

export interface CompletionOptions {
  pool: TokenPool;
  store: Store;
  messages: cg.OpenAIMessage[];
  /** requested model or alias */
  model: string;
  /** requested reasoning effort (OpenAI words or ChatGPT's) */
  effort?: string;
  /** abort when the caller goes away */
  signal?: AbortSignal;
  /** fired once, as soon as an upstream conversation is open (before any delta) */
  onStart?: () => void;
  /** resolved / actually-served model (may fire twice: resolution, then backend echo) */
  onModel?: (slug: string, effort?: string) => void;
  /** return 'stop' to end the completion early (stop sequence / max_tokens) — finish becomes 'length'/'stop' as given */
  onDelta?: (text: string) => void | 'stop' | 'length';
  /** incremental thought summaries (reasoning models) */
  onReasoning?: (text: string) => void;
  /** a short note about something the engine did (failover, retry) — for the request log */
  onNote?: (note: string) => void;
  /** fired before onStart when the request continues an existing backend conversation (n = messages sent) */
  onContinue?: (newMessages: number) => void;
}

export interface CompletionResult {
  ok: boolean;
  text: string;
  finish: string;
  /** slug that answered (backend echo) or the resolved slug */
  servedModel: string;
  effort?: string;
  /** HTTP-ish status for the caller: 200, 429, 499 (client gone), 502, 503 */
  status: number;
  error?: string;
  /** set when the stream broke after some text was already delivered */
  interrupted?: string;
  /** accumulated thought summaries */
  reasoning?: string;
  /** number of new messages sent into an existing backend conversation (0 = full resend) */
  continued?: number;
  latencyMs: number;
  aborted: boolean;
}

/** Human-readable text for ChatGPT's inline `error` SSE payloads. */
export function describeUpstreamError(e: unknown): string {
  if (typeof e === 'string') return e.slice(0, 300);
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const msg = typeof o.message === 'string' ? o.message : '';
    const code = typeof o.code === 'string' ? o.code : '';
    if (msg || code) return `${code ? `${code}: ` : ''}${msg}`.slice(0, 300);
  }
  return JSON.stringify(e).slice(0, 300);
}

/** Quota / model-cap errors — the session is fine, the plan just ran dry. */
export function isModelCap(e: unknown): boolean {
  const text = describeUpstreamError(e).toLowerCase();
  return /model_cap|cap_exceeded|hit your limit|usage limit|usage_limit|out of credits|too many requests|rate limit/.test(text);
}

function retryable(err: unknown): boolean {
  if (err instanceof cg.UpstreamError) {
    if (err.code === 401) return true; // token expired — try another
    if (err.code === 403 || err.code === 429) return true;
    if (err.code >= 500) return true;
    return false;
  }
  return true; // network / unknown — worth one more shot
}

export async function runCompletion(opts: CompletionOptions): Promise<CompletionResult> {
  const { pool, messages, model, effort, signal } = opts;
  const started = Date.now();
  const aborted = () => !!signal?.aborted;

  let attempts = 0;
  let lastError: unknown = null;
  let servedModel = model;
  let servedEffort: string | undefined;
  const tried = new Set<string>();
  let wantSlug: string | undefined; // resolved upstream slug, once known — lets pick() skip capped sessions
  const policy = opts.store.settings.continuation ?? 'temp';
  let cont: ContinuationHit | null = policy === 'off' ? null : findContinuation(messages, model, effort);
  let contFailures = 0; // a broken continuation is retried as a full resend and must not eat a session attempt

  const maxAttempts = () => MAX_ATTEMPTS + contFailures + [...tried].filter((id) => pool.isCapped(id, wantSlug)).length;
  while (attempts < maxAttempts() && !aborted()) {
    attempts++;
    // a continuation is bound to the account that holds the conversation
    let tokenUsed = cont && !tried.has(cont.entry.tokenId) ? pool.pickById(cont.entry.tokenId, cont.entry.model) : null;
    if (!tokenUsed) { cont = null; tokenUsed = pool.pick(tried, wantSlug); }
    let continuing = false;
    try {
      if (!tokenUsed) {
        // nothing left to try — surface the real upstream error if we have one
        if (lastError) break;
        throw new cg.UpstreamError(503, 'No healthy ChatGPT sessions in the pool. Add or refresh sessions in the admin console.');
      }
      tried.add(tokenUsed.id);
      const creds = await pool.ensureAccess(tokenUsed);
      const requirements = await cg.fetchRequirements(creds.accessToken, creds.deviceId, creds.ua, creds.accountId);
      // NOTE: turnstile.required is advisory — the conversation endpoint
      // accepts requirements-token + proof. We proceed and let upstream decide.
      const resolved = cg.resolveModel(model, effort, pool.catalog(tokenUsed));
      servedModel = resolved.slug;
      servedEffort = resolved.effort;
      wantSlug = resolved.slug;
      if (attempts > 1) opts.onNote?.(`retry ${attempts} on ${tokenUsed.label}`);
      opts.onModel?.(resolved.slug, resolved.effort);
      // work-mode conversations only continue when saved to the account; temporary ones do for plain models
      const persistNew = !!resolved.workMode && policy === 'all';
      if (cont && (cont.entry.model !== resolved.slug || (resolved.workMode && !cont.entry.persisted))) cont = null;
      continuing = !!cont;
      const target: cg.ConversationTarget = cont
        ? { conversationId: cont.entry.conversationId, parentMessageId: cont.entry.parentId, persisted: cont.entry.persisted }
        : { persisted: persistNew };
      const upstreamMessages = cont ? cont.newMessages : messages;
      const opened = await cg.openConversation(creds, upstreamMessages, resolved, requirements, signal, target);
      if (continuing) opts.onContinue?.(upstreamMessages.length);
      opts.onStart?.();

      let out = '';
      let reasoning = '';
      let finish = 'stop';
      let streamError: string | null = null;
      let upstreamErr: unknown = null;
      let softStop = false;
      let kinds: string[] = [];
      let convId = '';
      let assistantId = '';
      try {
        for await (const ev of cg.parseChatGPTSSE(opened.res.body!, opened.inputIds)) {
          if (ev.upstreamError) {
            upstreamErr = ev.upstreamError;
            streamError = describeUpstreamError(ev.upstreamError);
            break;
          }
          if (ev.modelSlug && ev.modelSlug !== servedModel) {
            servedModel = ev.modelSlug;
            opts.onModel?.(servedModel, servedEffort);
          }
          if (ev.reasoning) {
            reasoning += ev.reasoning;
            opts.onReasoning?.(ev.reasoning);
          }
          if (ev.delta) {
            out += ev.delta;
            const verdict = opts.onDelta?.(ev.delta);
            if (verdict === 'stop' || verdict === 'length') {
              finish = verdict;
              softStop = true;
              break;
            }
          }
          if (ev.finish) finish = ev.finish;
          if (ev.kinds) kinds = ev.kinds;
          if (ev.conversationId) convId = ev.conversationId;
          if (ev.assistantId) assistantId = ev.assistantId;
        }
      } catch (streamErr) {
        streamError = streamErr instanceof Error ? streamErr.message : String(streamErr);
      }

      if (aborted()) {
        return { ok: false, text: out, finish: 'stop', servedModel, effort: servedEffort, status: 499, error: 'client disconnected', latencyMs: Date.now() - started, aborted: true };
      }
      if (streamError && !out) {
        // nothing delivered — treat as a failed attempt
        if (upstreamErr && isModelCap(upstreamErr)) {
          // the account hit this model's quota: remember it for an hour and try another session for the same model
          pool.markModelCap(tokenUsed, servedModel);
          tried.add(tokenUsed.id);
          const left = pool.availableFor(servedModel, tried);
          console.warn(`[engine] model cap on ${tokenUsed.label} for ${servedModel}; ${left} other session(s) can still serve it`);
          if (left > 0) { opts.onNote?.(`model cap on ${tokenUsed.label} → failover`); lastError = new cg.UpstreamError(429, 'model_cap_reached', streamError); continue; }
          throw new cg.UpstreamError(429, 'model_cap_reached', streamError);
        }
        throw new cg.UpstreamError(502, 'upstream stream error', streamError);
      }
      pool.markSuccess(tokenUsed);
      if (continuing && !out.trim()) {
        // the backend lost the thread (expired or hidden conversation): resend everything once
        forgetConversation(cont!.entry.conversationId);
        cont = null;
        contFailures++;
        opts.onNote?.('continuation lost → full resend');
        console.warn('[engine] continuation produced nothing — falling back to a full resend');
        continue;
      }
      if (policy !== 'off' && convId && assistantId && out.trim() && !streamError) {
        rememberContinuation(messages, model, effort, {
          conversationId: convId,
          parentId: assistantId,
          tokenId: tokenUsed.id,
          model: resolved.slug,
          persisted: !!target.persisted,
        });
      }
      if (continuing) opts.onNote?.(`continued (+${upstreamMessages.length})`);
      if (!out.trim() && !streamError) {
        // the model answered only with non-text content (widget, image, card)
        const what = kinds.filter((k) => k !== 'thoughts' && k !== 'reasoning_recap');
        console.warn(`[engine] empty turn from ${servedModel}: ${what.join(', ') || 'no assistant content'}`);
        const note = `[shadowgate: the model produced no text for this turn — it ${what.length ? `only produced ${what.join(', ')} (its own sandbox output, which is not forwarded)` : 'answered with nothing that can be forwarded'}. Ask again in plain words.]`;
        opts.onDelta?.(note);
        out = note;
      }
      return {
        ok: true,
        text: out,
        finish: streamError && !softStop ? 'stop' : finish,
        servedModel,
        effort: servedEffort,
        status: 200,
        interrupted: streamError ?? undefined,
        reasoning: reasoning || undefined,
        continued: continuing ? upstreamMessages.length : 0,
        latencyMs: Date.now() - started,
        aborted: false,
      };
    } catch (err) {
      if (aborted()) break;
      if (continuing && cont) {
        // the conversation is gone or refused — never the session's fault; resend everything
        forgetConversation(cont.entry.conversationId);
        cont = null;
        contFailures++;
        opts.onNote?.('continuation failed → full resend');
        console.warn(`[engine] continuation failed (${err instanceof Error ? err.message : err}) — falling back to a full resend`);
        continue;
      }
      lastError = err;
      if (err instanceof cg.UpstreamError && err.message === 'model_cap_reached') break;
      const code = err instanceof cg.UpstreamError ? err.code : 0;
      const cause = (err as any)?.cause?.message || (err as any)?.cause?.code;
      console.warn(`[engine] attempt ${attempts} failed: ${err instanceof Error ? err.message : err}${cause ? ` (${cause})` : ''}`);
      if (tokenUsed) {
        pool.markFailure(tokenUsed, err);
        // only 401/403/429 are the SESSION's fault — network blips and 5xx
        // may be retried on the same session (keep-alive resets are common)
        if (code === 401 || code === 403 || code === 429) tried.add(tokenUsed.id);
        else tried.delete(tokenUsed.id);
      }
      if (!retryable(err)) break;
    }
  }

  if (aborted()) {
    return { ok: false, text: '', finish: 'stop', servedModel, effort: servedEffort, status: 499, error: 'client disconnected', latencyMs: Date.now() - started, aborted: true };
  }
  const message = lastError instanceof Error ? lastError.message : 'Unknown upstream error';
  const detail = lastError instanceof cg.UpstreamError && lastError.detail ? ` — ${lastError.detail}` : '';
  const rawStatus = lastError instanceof cg.UpstreamError ? lastError.code : 502;
  // a 401 from upstream is the SESSION's problem, not the caller's — report 502-class
  const status =
    rawStatus === 401 ? 502 :
    rawStatus === 429 ? 429 :
    rawStatus === 503 ? 503 :
    rawStatus >= 400 && rawStatus < 600 ? rawStatus : 502;
  return {
    ok: false,
    text: '',
    finish: 'stop',
    servedModel,
    effort: servedEffort,
    status,
    error: `${message}${detail}`.slice(0, 500),
    latencyMs: Date.now() - started,
    aborted: false,
  };
}
