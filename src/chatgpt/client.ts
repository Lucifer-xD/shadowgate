// Minimal, hardened client for the ChatGPT web backend.
import { randomUUID } from 'node:crypto';
import { assetPart, attachmentMeta, loadImage, uploadImage, type ImageAsset } from './images.js';
import { conversationProof, requirementsProof, setPoWUserAgent, warmBuildId } from './pow.js';

export const BASE = 'https://chatgpt.com';

export class UpstreamError extends Error {
  constructor(
    public code: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface SessionInfo {
  accessToken: string;
  expires?: string;
  email?: string;
  name?: string;
  planType?: string;
  accountId?: string;
}

/** Exchange a __Secure-next-auth.session-token for a fresh access token. */
export async function refreshSession(
  sessionToken: string,
  deviceId: string,
  ua: string,
): Promise<SessionInfo> {
  const r = await fetch(`${BASE}/api/auth/session`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': ua,
      accept: '*/*',
      cookie: `__Secure-next-auth.session-token=${sessionToken}`,
      'oai-device-id': deviceId,
    },
  });
  if (r.status === 401) {
    throw new UpstreamError(401, 'session_expired', `auth/session -> ${r.status}`);
  }
  if (r.status === 403) {
    throw new UpstreamError(403, 'session_blocked', 'auth/session -> 403 (challenge or block — cooling down)');
  }
  if (r.status !== 200) {
    throw new UpstreamError(r.status, 'session_refresh_failed', `auth/session -> ${r.status}`);
  }
  const j = (await r.json().catch(() => null)) as any;
  if (!j || typeof j.accessToken !== 'string' || j.accessToken.length < 20) {
    throw new UpstreamError(401, 'session_expired', 'auth/session returned no accessToken');
  }
  return {
    accessToken: j.accessToken,
    expires: j.expires,
    email: j.user?.email,
    name: j.user?.name,
    planType: j.account?.planType,
    accountId:
      j.account && j.account.structure === 'workspace' && j.account.id ? j.account.id : undefined,
  };
}

export interface Requirements {
  token: string;
  seed?: string;
  difficulty?: string;
  powRequired: boolean;
  turnstileRequired: boolean;
}

/** Ask the sentinel for a conversation requirements token (+ PoW challenge). */
export async function fetchRequirements(
  accessToken: string,
  deviceId: string,
  ua: string,
  accountId?: string,
): Promise<Requirements> {
  const r = await fetch(`${BASE}/backend-api/sentinel/chat-requirements`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': ua,
      accept: '*/*',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'oai-device-id': deviceId,
      'oai-language': 'en-US',
      origin: BASE,
      referer: `${BASE}/`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    },
    body: JSON.stringify({ p: requirementsProof() }),
  });
  if (r.status === 401) {
    throw new UpstreamError(401, 'session_expired', `chat-requirements -> ${r.status}`);
  }
  if (r.status === 403) {
    throw new UpstreamError(403, 'session_blocked', 'chat-requirements -> 403 (challenge or block — cooling down)');
  }
  if (r.status !== 200) {
    throw new UpstreamError(r.status, 'requirements_failed', `chat-requirements -> ${r.status}`);
  }
  const j = (await r.json().catch(() => null)) as any;
  if (!j || typeof j.token !== 'string') {
    throw new UpstreamError(502, 'requirements_failed', 'chat-requirements returned no token');
  }
  if (j.force_login) {
    throw new UpstreamError(401, 'session_expired', 'chat-requirements force_login');
  }
  return {
    token: j.token,
    seed: j.proofofwork?.seed,
    difficulty: j.proofofwork?.difficulty,
    powRequired: !!j.proofofwork?.required,
    turnstileRequired: !!j.turnstile?.required,
  };
}

// ── models: discovery + resolution ───────────────────────────────────────

export interface ModelInfo {
  slug: string;
  title: string;
  /** backend reasoning_type: auto | reasoning | pro | instant | … */
  reasoning: string;
  /** thinking_effort values the backend accepts for this slug ("standard", "extended") */
  efforts: string[];
  maxTokens?: number;
  /**
   * Work-mode model ("-wm" slugs: GPT-6 Astra/Luna/Sol, 5.6 Terra…). The
   * backend only serves these when the conversation carries
   * conversation_origin: "tpp"; otherwise it silently answers with the
   * default model.
   */
  workMode?: boolean;
  /**
   * Clean public name for a work-mode model: the catalog lists "gpt-6-astra"
   * and sends "gpt-6-astra-wm" (with the work-mode conversation shape) upstream.
   */
  upstreamSlug?: string;
}

/**
 * The GPT-6 family (and the 5.6 codenames) exist only as work-mode slugs
 * ("gpt-6-astra-wm"), served when the conversation carries
 * conversation_origin: "tpp". Give each one a clean public name without the
 * suffix; requests for the clean name are routed to the real work-mode model.
 *
 * Why not the bare slug: chatgpt.com echoes ANY slug back as model_slug —
 * "gpt-6-astra", "gpt-9-zeus" and "gpt-6" all answer, all identically, from
 * the plan's fallback lane (system-prompt name "GPT-6", cutoff Aug 2024),
 * while "gpt-6-astra-wm" in work mode is a different model (cutoff Aug 2025).
 * Verified 2026-10-20. The echo makes the bare names look real; they are not.
 */
export function withCleanWorkModels(cat: ModelCatalog): ModelCatalog {
  if (!cat.models.length) return cat;
  const have = new Set(cat.models.map((m) => m.slug.toLowerCase()));
  const clean: ModelInfo[] = [];
  for (const m of cat.models) {
    if (!m.workMode || !/-wm$/i.test(m.slug)) continue;
    const name = m.slug.slice(0, -3);
    if (have.has(name.toLowerCase())) continue;
    clean.push({ ...m, slug: name, upstreamSlug: m.slug });
  }
  return uniqueTitles(clean.length ? { ...cat, models: [...cat.models, ...clean] } : cat);
}

/** Kept for callers that used the old name. */
export const withDirectModels = withCleanWorkModels;


/**
 * chatgpt.com titles whole families alike ("GPT-5.6 Sol" for the router, the
 * instant lane and the thinking lane). Give each slug a title of its own so
 * pickers and searches tell them apart.
 */
export function uniqueTitles(cat: ModelCatalog): ModelCatalog {
  // only listed models compete for a title; the unlisted -wm twins keep theirs
  const count = new Map<string, number>();
  for (const m of cat.models) if (!/-wm$/i.test(m.slug)) count.set(m.title, (count.get(m.title) ?? 0) + 1);
  const suffix = (slug: string): string => {
    const s = slug.toLowerCase();
    if (/-t-mini$/.test(s)) return 'Thinking Mini';
    if (/mini$/.test(s)) return 'Mini';
    if (/instant$/.test(s)) return 'Instant';
    if (/thinking$/.test(s)) return 'Thinking';
    if (/pro$/.test(s)) return 'Pro';
    if (/-wm$/.test(s)) return 'Work';
    return 'Auto';
  };
  const models = cat.models.map((m) => {
    if (/-wm$/i.test(m.slug) || (count.get(m.title) ?? 0) < 2) return m;
    const sfx = suffix(m.slug);
    return m.title.toLowerCase().includes(sfx.toLowerCase()) ? m : { ...m, title: `${m.title} ${sfx}` };
  });
  return { ...cat, models };
}

export interface ModelCatalog {
  models: ModelInfo[];
  defaultModel: string;
}

/** GET /backend-api/models — what this account may actually use. */
export async function fetchModels(creds: ConversationCreds): Promise<ModelCatalog> {
  const r = await fetch(`${BASE}/backend-api/models?history_and_training_disabled=false`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': creds.ua,
      accept: '*/*',
      authorization: `Bearer ${creds.accessToken}`,
      'oai-device-id': creds.deviceId,
      'oai-language': 'en-US',
      referer: `${BASE}/`,
      ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
    },
  });
  if (r.status === 401) throw new UpstreamError(401, 'session_expired', 'models -> 401');
  if (r.status !== 200) throw new UpstreamError(r.status, 'models_failed', `models -> ${r.status}`);
  const j = (await r.json().catch(() => null)) as any;
  const models: ModelInfo[] = Array.isArray(j?.models)
    ? j.models
        // Deep Research is a different flow, not a chat model
        .filter((m: any) => typeof m?.slug === 'string' && m.slug !== 'research')
        .map((m: any) => ({
          workMode: !!m.is_work_mode_model || String(m.slug).endsWith('-wm'),
          slug: m.slug,
          title: String(m.title || m.slug),
          reasoning: String(m.reasoning_type || 'auto'),
          efforts: Array.isArray(m.thinking_efforts)
            ? m.thinking_efforts.map((e: any) => String(e?.thinking_effort ?? e)).filter(Boolean)
            : [],
          maxTokens: typeof m.max_tokens === 'number' ? m.max_tokens : undefined,
        }))
    : [];
  const defaultModel =
    typeof j?.default_model_slug === 'string' && j.default_model_slug ? j.default_model_slug : models[0]?.slug ?? 'auto';
  return { models, defaultModel };
}

/** Used until a session has reported a catalog. */
export const FALLBACK_CATALOG: ModelCatalog = { models: [], defaultModel: 'auto' };

export interface ResolvedModel {
  slug: string;
  /** thinking_effort to send, if the slug supports it */
  effort?: string;
  /** send conversation_origin: "tpp" (work-mode models) */
  workMode?: boolean;
  /** what the client asked for */
  requested: string;
}

const norm = (s: string) => s.trim().toLowerCase();
/** "gpt-5.6-thinking" → "gpt-5-6-thinking"; strips date suffixes like -2025-10-01 */
const canon = (s: string) => norm(s).replace(/\./g, '-').replace(/-\d{4}-\d{2}-\d{2}$/, '');

const HIGH = /^(high|xhigh|max|extended|heavy|deep|ultra)$/;
const LOW = /^(none|off|minimal|low|medium|standard|light|default|auto)$/;

/**
 * OpenAI reasoning_effort spellings a client may send, and what each becomes
 * upstream. ChatGPT's thinking models know two efforts, standard and extended,
 * so the six OpenAI levels collapse onto those two.
 */
export const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export function effortTable(available: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (available.length < 2) return out; // one effort (Pro: standard only) — nothing to choose
  for (const e of OPENAI_EFFORTS) {
    const m = mapEffort(e, available);
    if (m) out[e] = m;
  }
  return out;
}

/** Map OpenAI reasoning_effort (or ChatGPT's own words) onto a model's effort list. */
export function mapEffort(requested: string | undefined, available: string[]): string | undefined {
  if (!requested || available.length === 0) return undefined;
  const r = norm(requested);
  if (available.includes(r)) return r;
  if (HIGH.test(r)) return available.includes('extended') ? 'extended' : available[available.length - 1];
  if (LOW.test(r)) return available.includes('standard') ? 'standard' : available[0];
  return undefined;
}

function versionOf(slug: string): number {
  const m = slug.match(/(\d+)(?:[-.](\d+))?/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
}

/**
 * Resolve the model a client asked for against the catalog the session can
 * use. Exact slugs pass through; everything else is an alias:
 *   auto / gpt-4o / gpt-4 / gpt-5 / unknown → account default (router)
 *   *thinking* / o1 / o3 / o4           → newest reasoning model
 *   *pro*                                → newest pro model
 *   *mini* / *nano* / gpt-3.5            → newest mini (thinking mini if asked)
 *   *instant*                            → instant lane
 * A high reasoning_effort on a non-reasoning alias upgrades to the thinking lane.
 */
export function resolveModel(requested: string | undefined, effortReq: string | undefined, cat: ModelCatalog): ResolvedModel {
  const want = requested && requested.trim() ? requested.trim() : 'auto';
  const key = canon(want);
  const { models } = cat;
  const bySlug = (slug: string) => models.find((m) => canon(m.slug) === canon(slug));
  // "gpt-5-pro" should land on a 5.x Pro model before a 6.x one
  const wantMajor = key.match(/^gpt-(\d+)/)?.[1];
  // lane aliases (thinking/pro/mini/instant, o-series) stay on the plain listed
  // models; codename and bare-generation aliases may land on work-mode ones
  const pick = (pred: (m: ModelInfo) => boolean, preferPlain = true): ModelInfo | undefined => {
    const c = models.filter((m) => m.slug !== 'research' && pred(m));
    c.sort((a, b) =>
      (preferPlain ? Number(!!a.workMode) - Number(!!b.workMode) : 0) ||
      versionOf(b.slug) - versionOf(a.slug) ||
      Number(!!a.workMode) - Number(!!b.workMode) ||
      // among twins prefer the clean name (so "astra" → gpt-6-astra, sent as gpt-6-astra-wm)
      Number(/-wm$/i.test(a.slug)) - Number(/-wm$/i.test(b.slug)));
    if (wantMajor) {
      const same = c.find((m) => m.slug.match(/^gpt-(\d+)/)?.[1] === wantMajor);
      if (same) return same;
    }
    return c[0];
  };
  const finish = (m: ModelInfo | undefined, fallback: string): ResolvedModel => ({
    slug: m?.upstreamSlug ?? m?.slug ?? fallback,
    effort: m ? mapEffort(effortReq, m.efforts) : undefined,
    workMode: m?.workMode || undefined,
    requested: want,
  });

  const exact = bySlug(key);
  if (exact) return finish(exact, exact.slug);

  // codename aliases: "astra", "gpt-6-luna", "sol", "terra" → newest model whose title carries the word
  const word = key.match(/(astra|luna|terra|sol|nova|orion)/)?.[1];
  const effortHigh = HIGH.test(norm(effortReq ?? ''));
  if (word) {
    const byTitle = pick((m) => m.title.toLowerCase().split(/\s+/).includes(word), false);
    if (byTitle) return finish(byTitle, cat.defaultModel);
  }
  // bare generation with no plain model of that generation ("gpt-6") → newest
  // non-Pro model of the generation, work-mode or not; a high effort wants thinking
  if (/^gpt-\d+$/.test(key) && wantMajor) {
    const inGen = (m: ModelInfo) => m.slug.match(/^gpt-(\d+)/)?.[1] === wantMajor && m.reasoning !== 'pro';
    const plainExists = models.some((m) => inGen(m) && !m.workMode);
    if (!plainExists) {
      const gen = pick((m) => inGen(m) && (!effortHigh || m.reasoning === 'reasoning'), false) ?? pick(inGen, false);
      if (gen) return finish(gen, cat.defaultModel);
    }
  }

  const wantsThinking = /thinking|reason|^o[134]/.test(key) || effortHigh;
  const wantsMini = /mini|nano|3-5/.test(key);
  const wantsPro = /pro/.test(key);
  const wantsInstant = /instant/.test(key);
  const isReasoning = (m: ModelInfo) => m.reasoning === 'reasoning';
  if (wantsPro) return finish(pick((m) => m.reasoning === 'pro') ?? pick(isReasoning), cat.defaultModel);
  if (wantsMini && wantsThinking) return finish(pick((m) => /-t-mini$/.test(m.slug)) ?? pick((m) => /mini/.test(m.slug)), cat.defaultModel);
  if (wantsMini) return finish(pick((m) => /mini$/.test(m.slug) && !/-t-mini$/.test(m.slug)) ?? pick((m) => /mini/.test(m.slug)), cat.defaultModel);
  if (wantsInstant) return finish(pick((m) => m.reasoning === 'instant' || /instant/.test(m.slug)), cat.defaultModel);
  if (wantsThinking) return finish(pick((m) => isReasoning(m) && !/mini/.test(m.slug)) ?? pick(isReasoning), cat.defaultModel);
  return finish(bySlug(cat.defaultModel), cat.defaultModel);
}

// ── request building ─────────────────────────────────────────────────────

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

function textOf(content: OpenAIMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n');
}

/** chatgpt.com rejects a single message above roughly 300k characters ("message_length_exceeds_limit"). */
export const MAX_UPSTREAM_MESSAGE_CHARS = 240_000;

/** Split one oversized text into consecutive messages of the same role, cutting at line breaks. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_UPSTREAM_MESSAGE_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_UPSTREAM_MESSAGE_CHARS) {
    let cut = rest.lastIndexOf('\n', MAX_UPSTREAM_MESSAGE_CHARS);
    if (cut < MAX_UPSTREAM_MESSAGE_CHARS * 0.5) cut = MAX_UPSTREAM_MESSAGE_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

export interface ConversationTarget {
  /** continue this backend conversation instead of starting a new one */
  conversationId?: string;
  /** the backend's last assistant message id (parent for the new turn) */
  parentMessageId?: string;
  /** keep the conversation in the account's history (needed to continue work-mode conversations) */
  persisted?: boolean;
}

export function buildConversationBody(messages: OpenAIMessage[], model: string, thinkingEffort?: string, workMode = false, assets?: Map<number, ImageAsset[]>, target: ConversationTarget = {}) {
  return {
    action: 'next',
    conversation_mode: { kind: 'primary_assistant' },
    ...(target.conversationId ? { conversation_id: target.conversationId } : {}),
    messages: messages.flatMap((m, i) => {
      const imgs = assets?.get(i) ?? [];
      const parts = splitLong(textOf(m.content));
      return parts.map((part, j) => {
        const withImages = j === 0 && imgs.length > 0;
        return {
          id: randomUUID(),
          author: { role: m.role === 'system' ? 'critic' : m.role },
          content: withImages
            ? { content_type: 'multimodal_text', parts: [...imgs.map(assetPart), part] }
            : { content_type: 'text', parts: [part] },
          ...(withImages ? { metadata: { attachments: imgs.map(attachmentMeta) } } : {}),
        };
      });
    }),
    parent_message_id: target.parentMessageId ?? randomUUID(),
    model,
    history_and_training_disabled: !target.persisted,
    websocket_request_id: randomUUID(),
    force_use_sse: true,
    ...(thinkingEffort ? { thinking_effort: thinkingEffort } : {}),
    // work-mode models are only honoured inside a "tpp" (work) conversation
    ...(workMode ? { conversation_origin: 'tpp' } : {}),
  };
}

export interface ConversationCreds {
  accessToken: string;
  deviceId: string;
  ua: string;
  accountId?: string;
}

export interface OpenedConversation {
  res: Response;
  /** ids of the messages we sent — the backend echoes them back and they must not be treated as output */
  inputIds: Set<string>;
}

/** Hide a saved conversation from the account's history (chatgpt.com's "delete"). */
export async function hideConversation(creds: ConversationCreds, conversationId: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/backend-api/conversation/${conversationId}`, {
      method: 'PATCH',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'user-agent': creds.ua,
        accept: '*/*',
        'content-type': 'application/json',
        authorization: `Bearer ${creds.accessToken}`,
        'oai-device-id': creds.deviceId,
        'oai-language': 'en-US',
        origin: BASE,
        referer: `${BASE}/`,
        ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
      },
      body: JSON.stringify({ is_visible: false }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Upload every image_url part to the account's file service; keyed by message index. */
async function uploadImages(creds: ConversationCreds, messages: OpenAIMessage[], signal: AbortSignal): Promise<Map<number, ImageAsset[]> | undefined> {
  let out: Map<number, ImageAsset[]> | undefined;
  for (let i = 0; i < messages.length; i++) {
    const c = messages[i].content;
    if (!Array.isArray(c)) continue;
    const urls = c.filter((p) => p.type === 'image_url' && p.image_url?.url).map((p) => p.image_url!.url);
    if (urls.length === 0) continue;
    const uploaded: ImageAsset[] = [];
    for (const url of urls) uploaded.push(await uploadImage(creds, await loadImage(url, signal), signal));
    (out ??= new Map()).set(i, uploaded);
  }
  return out;
}

/** POST /backend-api/conversation and return the raw SSE response. */
export async function openConversation(
  creds: ConversationCreds,
  messages: OpenAIMessage[],
  model: ResolvedModel,
  req: Requirements,
  clientSignal?: AbortSignal,
  target: ConversationTarget = {},
): Promise<OpenedConversation> {
  if (creds.ua) setPoWUserAgent(creds.ua);
  void warmBuildId(); // fire-and-forget fingerprint warmup
  const proof =
    req.powRequired && req.seed && req.difficulty
      ? conversationProof(req.seed, req.difficulty)
      : '';
  const timeout = AbortSignal.timeout(300_000);
  const signal = clientSignal ? AbortSignal.any([timeout, clientSignal]) : timeout;
  const assets = await uploadImages(creds, messages, signal);
  const payload = buildConversationBody(messages, model.slug, model.effort, !!model.workMode, assets, target);
  const inputIds = new Set(payload.messages.map((m) => m.id));
  const r = await fetch(`${BASE}/backend-api/conversation`, {
    method: 'POST',
    signal,
    headers: {
      'user-agent': creds.ua,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${creds.accessToken}`,
      'oai-device-id': creds.deviceId,
      'oai-language': 'en-US',
      origin: BASE,
      referer: `${BASE}/`,
      'openai-sentinel-chat-requirements-token': req.token,
      ...(proof ? { 'openai-sentinel-proof-token': proof } : {}),
      ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (r.status !== 200 || !r.body) {
    let detail = '';
    try {
      detail = (await r.text()).slice(0, 400);
    } catch { /* ignore */ }
    const msg =
      r.status === 401 ? 'session_expired' :
      r.status === 403 ? 'session_blocked' :
      r.status === 429 ? 'session_rate_limited' : 'conversation_failed';
    throw new UpstreamError(r.status, msg, `conversation -> ${r.status} ${detail}`.trim());
  }
  return { res: r, inputIds };
}

// ── SSE translation ──────────────────────────────────────────────────────

export interface StreamEvent {
  delta?: string;
  /** incremental reasoning summary text (ChatGPT "thoughts") */
  reasoning?: string;
  finish?: string;
  conversationId?: string;
  /** content kinds the assistant produced this turn ("text", "code→python", "execution_output", …) — diagnostics for empty turns */
  kinds?: string[];
  /** id of the backend's last assistant message this turn — the parent for a continuation */
  assistantId?: string;
  /** slug the backend actually answered with (from message metadata) */
  modelSlug?: string;
  upstreamError?: unknown;
}

/**
 * Strip ChatGPT's private-use markup from visible text: genui widget refs and
 * citation markers (U+E200 … U+E201 spans) and writing-block fences.
 */
export function cleanVisibleText(s: string): string {
  return s
    .replace(/\ue200[\s\S]*?\ue201/g, '')
    .replace(/[\ue200-\ue20f]/g, '')
    .replace(/:::writing\{[^}\n]*\}\n?/g, '')
    .replace(/^:::[ \t]*$\n?/gm, '');
}

/**
 * Link cards and citations are sent as private-use markers in the text plus
 * a `content_references` entry whose `alt` is the markdown rendering
 * ("[OpenAI Admin — Members](https://…)", "([Help Center](https://…))").
 * Substitute the markdown so URLs survive the translation.
 */
export function applyContentReferences(text: string, refs: unknown): string {
  if (!Array.isArray(refs) || !refs.length) return text;
  let out = text;
  for (const r of refs as any[]) {
    const matched = r?.matched_text;
    if (typeof matched !== 'string' || !matched || !matched.includes('\ue200')) continue;
    let alt = typeof r.alt === 'string' ? r.alt : '';
    if (!alt && Array.isArray(r.items)) {
      const links = r.items.filter((i: any) => typeof i?.url === 'string').map((i: any) => `[${i.title || i.url}](${i.url})`);
      alt = links.length ? ` (${links.join(', ')})` : '';
    }
    if (!alt && typeof r.url === 'string') alt = `[${r.title || r.url}](${r.url})`;
    out = out.split(matched).join(alt);
  }
  return out;
}

/**
 * Drop an unterminated marker from the end of streamed text so it is never
 * emitted half-typed: an open U+E200 span, or a writing fence still arriving.
 */
export function holdBackPartialMarkup(s: string): string {
  const o = s.lastIndexOf('\ue200');
  if (o !== -1 && s.indexOf('\ue201', o) === -1) s = s.slice(0, o);
  const m = s.match(/(?:^|\n)(:{1,3}(?:writing(?:\{[^}\n]*)?|w|wr|wri|writ|writi|writin)?)$/);
  if (m) s = s.slice(0, s.length - m[1].length);
  return s;
}

interface TrackedMessage {
  id: string;
  parts: unknown[];
  refs: unknown; // metadata.content_references (link cards, citations)
  final: boolean; // message finished → unresolved markers may be dropped
  emitted: string; // cleaned text already sent for this message
}

/**
 * Consume the ChatGPT SSE stream and yield OpenAI-style incremental deltas.
 *
 * A turn may contain several assistant messages (code the model ran, tool
 * outputs, hidden widget placeholders, thought summaries, and finally the
 * visible answer). Every visible assistant text message is followed in order;
 * thoughts become reasoning events; everything else is ignored. Both the
 * classic full-message frames and the newer delta-patch frames are handled.
 */
export async function* parseChatGPTSSE(
  body: ReadableStream<Uint8Array>,
  skipIds: Set<string> = new Set(),
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let convId = '';
  let seenSlug = '';
  let finish: string | null = null;
  const messages = new Map<string, TrackedMessage>(); // visible assistant text messages, insertion-ordered
  const meta = new Map<string, any>(); // last full message object by id (for delta patches)
  const thoughts = new Map<string, string>(); // thought message id → emitted reasoning text
  let lastId = '';
  let outTail = ''; // last chars emitted overall, for joining messages

  const visible = (m: any): boolean => {
    if (m.author?.role !== 'assistant') return false;
    const ct: string = m.content?.content_type ?? '';
    if (ct !== 'text' && ct !== 'multimodal_text') return false;
    if (!Array.isArray(m.content?.parts)) return false;
    if (m.recipient && m.recipient !== 'all') return false;
    const mt = m.metadata?.message_type;
    if (mt && mt !== 'next' && mt !== 'continue') return false;
    if (m.metadata?.is_visually_hidden_from_conversation === true) return false;
    return true;
  };

  const emitText = function* (t: TrackedMessage): Generator<StreamEvent> {
    let raw = applyContentReferences(t.parts.filter((p) => typeof p === 'string').join(''), t.refs);
    raw = holdBackPartialMarkup(raw);
    if (!t.final) {
      // a complete marker whose reference has not arrived yet: wait for it
      const pending = raw.indexOf('\ue200');
      if (pending !== -1) raw = raw.slice(0, pending);
    }
    const full = cleanVisibleText(raw);
    let delta: string;
    if (full.startsWith(t.emitted)) delta = full.slice(t.emitted.length);
    else if (!t.emitted) delta = full;
    else return; // non-prefix rewrite of already-sent text — can't retract
    if (!delta) return;
    if (!t.emitted) {
      // first chunk of a new message: separate it from earlier output
      if (!outTail) delta = delta.replace(/^\s+/, '');
      else if (!/\s$/.test(outTail) && !/^\s/.test(delta)) delta = `\n\n${delta}`;
      if (!delta) return;
    }
    t.emitted = full;
    outTail = delta.slice(-2);
    yield { delta };
  };

  const kinds = new Set<string>();
  let lastAssistantId = '';
  const handleMessage = function* (m: any): Generator<StreamEvent> {
    if (!m || !m.id) return;
    if (skipIds.has(m.id)) return; // echo of a message we sent (history / system prompt)
    meta.set(m.id, m);
    if (m.author?.role === 'assistant' && (m.content?.content_type === 'text' || m.content?.content_type === 'multimodal_text')) lastAssistantId = m.id;
    if (m.author?.role === 'assistant' || m.author?.role === 'tool') {
      const k = m.author.role === 'tool' ? `tool:${m.author.name ?? '?'}` : `${m.content?.content_type ?? '?'}${m.recipient && m.recipient !== 'all' ? `→${m.recipient}` : ''}`;
      kinds.add(k);
    }
    if (typeof m.metadata?.model_slug === 'string' && m.metadata.model_slug !== seenSlug) {
      seenSlug = m.metadata.model_slug;
      yield { modelSlug: seenSlug };
    }
    const fd = m.metadata?.finish_details?.type;
    if (fd && m.author?.role === 'assistant') finish = fd === 'max_tokens' ? 'length' : 'stop';

    const ct: string = m.content?.content_type ?? '';
    if (m.author?.role === 'assistant' && ct === 'thoughts' && Array.isArray(m.content?.thoughts)) {
      const text = m.content.thoughts
        .map((t: any) => [t?.summary, t?.content].filter((x: unknown) => typeof x === 'string' && x).join('\n'))
        .filter(Boolean)
        .join('\n');
      const prev = thoughts.get(m.id) ?? '';
      if (text.startsWith(prev) && text.length > prev.length) {
        const chunk = (prev ? '' : thoughts.size ? '\n' : '') + text.slice(prev.length);
        thoughts.set(m.id, text);
        yield { reasoning: chunk };
      } else if (!prev && text) {
        thoughts.set(m.id, text);
        yield { reasoning: (thoughts.size > 1 ? '\n' : '') + text };
      }
      return;
    }
    if (m.author?.role === 'assistant' && ct === 'reasoning_recap' && typeof m.content?.content === 'string' && thoughts.size === 0) {
      // no thought summaries were streamed — surface the recap ("Worked for 12 seconds") instead
      thoughts.set(m.id, m.content.content);
      yield { reasoning: m.content.content };
      return;
    }
    // a code message addressed to the user (recipient "all") is visible code, not a sandbox call
    const visibleCode = m.author?.role === 'assistant' && ct === 'code' && (!m.recipient || m.recipient === 'all') && typeof m.content?.text === 'string' && m.metadata?.is_visually_hidden_from_conversation !== true;
    if (!visible(m) && !visibleCode) return;
    let t = messages.get(m.id);
    if (!t) {
      t = { id: m.id, parts: [], refs: undefined, final: false, emitted: '' };
      messages.set(m.id, t);
    }
    // code is emitted whole once the message is finished (a growing fenced block is not prefix-stable)
    const codeDone = visibleCode && m.status && m.status !== 'in_progress';
    t.parts = visibleCode
      ? (codeDone ? [`\n\`\`\`${m.content.language && m.content.language !== 'unknown' ? m.content.language : ''}\n${m.content.text}\n\`\`\`\n`] : [])
      : m.content.parts;
    if (Array.isArray(m.metadata?.content_references) && m.metadata.content_references.length) t.refs = m.metadata.content_references;
    if (m.status && m.status !== 'in_progress') t.final = true;
    if (m.end_turn === true) t.final = true;
    lastId = m.id;
    yield* emitText(t);
  };

  const handleData = function* (raw: string): Generator<StreamEvent> {
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      return;
    }
    if (v == null || typeof v !== 'object') return;
    if (v.error) {
      yield { upstreamError: v.error };
      return;
    }
    if (typeof v.conversation_id === 'string' && !convId) convId = v.conversation_id;
    if (v.type === 'message_stream_complete') return;

    // delta-encoding frames: {"v": {message…}} | {"p":"/message/content/parts/0","o":"append","v":"…"} | {"o":"patch","v":[…]}
    if (v.message) {
      yield* handleMessage(v.message);
      return;
    }
    if (v.v && typeof v.v === 'object' && !Array.isArray(v.v) && v.v.message) {
      if (typeof v.v.conversation_id === 'string' && !convId) convId = v.v.conversation_id;
      yield* handleMessage(v.v.message);
      return;
    }
    const ops: any[] = v.o === 'patch' && Array.isArray(v.v) ? v.v : (v.v !== undefined ? [v] : []);
    for (const op of ops) {
      const path: string = typeof op.p === 'string' ? op.p : '/message/content/parts/0';
      const base = meta.get(lastId);
      if (!base) continue;
      const m = op.p && !op.p.startsWith('/message') ? base : base;
      if (/^\/message\/content\/parts\/\d+$/.test(path) && typeof op.v === 'string') {
        const idx = parseInt(path.slice(path.lastIndexOf('/') + 1), 10);
        const parts: unknown[] = Array.isArray(m.content?.parts) ? m.content.parts : [];
        if (op.o === 'replace') parts[idx] = op.v;
        else parts[idx] = `${typeof parts[idx] === 'string' ? parts[idx] : ''}${op.v}`;
        m.content = { ...(m.content ?? {}), content_type: m.content?.content_type ?? 'text', parts };
        yield* handleMessage(m);
      } else if (path === '/message/status' && typeof op.v === 'string') {
        m.status = op.v;
      } else if (path === '/message/metadata' && op.v && typeof op.v === 'object') {
        m.metadata = { ...(m.metadata ?? {}), ...op.v };
        yield* handleMessage(m);
      } else if (path === '/message/end_turn') {
        m.end_turn = op.v;
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line.length < 6 || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data.startsWith('[DONE]')) {
          buffer = '';
          for (const t of messages.values()) if (!t.final) { t.final = true; yield* emitText(t); }
          yield { finish: finish ?? 'stop', conversationId: convId || undefined, kinds: [...kinds], assistantId: lastAssistantId || undefined };
          return;
        }
        yield* handleData(data);
      }
    }
    // stream ended without [DONE]
    for (const t of messages.values()) if (!t.final) { t.final = true; yield* emitText(t); }
    yield { finish: finish ?? 'stop', conversationId: convId || undefined, kinds: [...kinds], assistantId: lastAssistantId || undefined };
  } finally {
    reader.releaseLock();
    try { await body.cancel(); } catch { /* ignore */ }
  }
}
