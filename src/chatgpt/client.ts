// Minimal, hardened client for the ChatGPT web backend.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
  /** a bare GPT-6 slug sent in an ordinary chat conversation (listed on request; see withCleanWorkModels) */
  direct?: boolean;
  /**
   * Codex-lane twin of a work-mode model ("gpt-6-astra-codex"): the same -wm
   * model in a SAVED conversation, which ChatGPT runs through its Codex harness.
   * It continues in place, and it counts toward the plan's 5-hour and weekly
   * usage. The plain -wm row runs in a temporary chat (Harmony harness):
   * unmetered, but every turn resends the history. Verified 2026-10-22: two
   * small saved turns moved the 5-hour window 0% → 3%; temporary turns
   * moved nothing.
   */
  saved?: boolean;
}

/**
 * Two lanes answer GPT-6 names, and the listing says which is which:
 *
 *  - work-mode slugs ("gpt-6-astra-wm", "gpt-6.1-sol-wm", "gpt-6-luna-wm" …) are
 *    the real GPT-6 family. They are served only inside a work-mode conversation
 *    (conversation_origin "tpp") and spend the workspace's work credits.
 *  - the unlimited chat lane answers EVERY GPT-6-style name — gpt-6-astra,
 *    gpt-6-luna, gpt-6.1-sol, even made-up ones like gpt-9-zeus — with one and
 *    the same generic configuration whose system prompt calls it "GPT-6"
 *    (verified 2026-10-21 on the live session: gpt-6-astra and gpt-9-zeus gave
 *    identical answers, gpt-5-6 said "GPT-5.6 Sol"). It is listed once, as
 *    "gpt-6" (chat lane); any GPT-6 name without -wm is sent there as "gpt-6",
 *    so replies are labelled with what actually answered.
 */
export const DIRECT_MODELS: Array<{ slug: string; title: string; reasoning: string }> = [
  { slug: 'gpt-6', title: 'GPT-6 (chat lane, unmetered)', reasoning: 'auto' },
];

export function withCleanWorkModels(cat: ModelCatalog): ModelCatalog {
  if (!cat.models.length) return cat;
  const have = new Set(cat.models.map((m) => m.slug.toLowerCase()));
  const anyWm = cat.models.find((m) => m.workMode);
  const extra: ModelInfo[] = [];
  for (const d of DIRECT_MODELS) {
    if (have.has(d.slug.toLowerCase())) continue;
    const twin = cat.models.find((m) => m.slug === `${d.slug}-wm`);
    extra.push({
      slug: d.slug,
      title: d.title,
      reasoning: d.reasoning,
      efforts: ['standard', 'extended'],
      maxTokens: twin?.maxTokens ?? anyWm?.maxTokens ?? 262_144,
      direct: true,
    });
  }
  const models = [...cat.models, ...extra].map((m) => (m.workMode && !/work mode/i.test(m.title) ? { ...m, title: `${m.title} (work mode)` } : m));
  // each work-mode model also gets a metered Codex-lane twin (saved conversation, continues in place)
  const twins: ModelInfo[] = [];
  for (const m of models) {
    if (!m.workMode || m.saved || !/-wm$/i.test(m.slug)) continue;
    const slug = `${m.slug.replace(/-wm$/i, '')}-codex`;
    if (have.has(slug.toLowerCase())) continue;
    twins.push({ ...m, slug, upstreamSlug: m.upstreamSlug ?? m.slug, title: `${m.title.replace(/\s*\(work mode\)\s*$/i, '')} · Codex (metered)`, saved: true });
  }
  return uniqueTitles({ ...cat, models: [...models, ...twins] });
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
  for (const m of cat.models) count.set(m.title, (count.get(m.title) ?? 0) + 1);
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
    if ((count.get(m.title) ?? 0) < 2) return m;
    const sfx = suffix(m.slug);
    return m.title.toLowerCase().includes(sfx.toLowerCase()) ? m : { ...m, title: `${m.title} ${sfx}` };
  });
  return { ...cat, models };
}

export interface ModelCatalog {
  models: ModelInfo[];
  defaultModel: string;
}

/** Where the raw /backend-api/models reply is kept for diagnostics (no secrets in it); unset = not kept. */
let modelsDumpPath: string | undefined;
export function setModelsDumpPath(p: string): void { modelsDumpPath = p; }

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
  if (modelsDumpPath && j) {
    try { fs.writeFileSync(modelsDumpPath, JSON.stringify({ fetchedAt: new Date().toISOString(), reply: j }, null, 2), { mode: 0o600 }); } catch { /* diagnostics only */ }
  }
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

/**
 * GET /backend-api/tpp/models/ — the work-mode ("tpp") model catalog the ChatGPT
 * web app's work picker reads. It lists each work-mode model's own thinking
 * efforts, which can go beyond the chat catalog's standard/extended (the web
 * app knows min = Light, standard, extended, xhigh = Extra High, max = Heavy).
 */
export async function fetchWorkModels(creds: ConversationCreds): Promise<any> {
  const r = await fetch(`${BASE}/backend-api/tpp/models/?supports_model_picker_upgrade_presets=true`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': creds.ua,
      accept: '*/*',
      authorization: `Bearer ${creds.accessToken}`,
      'oai-device-id': creds.deviceId,
      'oai-language': 'en-US',
      referer: `${BASE}/work`,
      ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
    },
  });
  if (r.status === 401) throw new UpstreamError(401, 'session_expired', 'tpp/models -> 401');
  if (r.status !== 200) throw new UpstreamError(r.status, 'work_models_failed', `tpp/models -> ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json();
}

/** The thinking_effort values a model entry (chat or work catalog) offers. */
export function effortsOf(entry: any): string[] {
  return Array.isArray(entry?.thinking_efforts)
    ? entry.thinking_efforts.map((e: any) => String(e?.thinking_effort ?? e)).filter(Boolean)
    : [];
}

/** Where the raw work-mode catalog is kept for diagnostics (no secrets in it). */
let modelConfigDumpPath: string | undefined;
export function setModelConfigDumpPath(p: string): void { modelConfigDumpPath = p; }
export function dumpModelConfigs(configs: Record<string, unknown>): void {
  if (!modelConfigDumpPath) return;
  try { fs.writeFileSync(modelConfigDumpPath, JSON.stringify({ fetchedAt: new Date().toISOString(), configs }, null, 2), { mode: 0o600 }); } catch { /* diagnostics only */ }
}

/** Where the raw frames of the last turn that produced no assistant message are kept (diagnostics). */
let emptyTurnDumpPath: string | undefined;
export function setEmptyTurnDumpPath(p: string): void { emptyTurnDumpPath = p; }
function dumpEmptyTurn(frames: string[]): void {
  if (!emptyTurnDumpPath) return;
  try { fs.writeFileSync(emptyTurnDumpPath, JSON.stringify({ at: new Date().toISOString(), frames }, null, 2), { mode: 0o600 }); } catch { /* diagnostics only */ }
}

/** Used until a session has reported a catalog. */
export const FALLBACK_CATALOG: ModelCatalog = { models: [], defaultModel: 'auto' };

export interface ResolvedModel {
  slug: string;
  /** thinking_effort to send, if the slug supports it */
  effort?: string;
  /** send conversation_origin: "tpp" (work-mode models) */
  workMode?: boolean;
  /** run in a saved conversation (the metered Codex lane), see ModelInfo.saved */
  saved?: boolean;
  /** what the client asked for */
  requested: string;
}

/**
 * Plain (non-work-mode) models that run in a saved conversation by default
 * instead of a temporary one. GPT-5.6 Sol (auto, instant, thinking): measured
 * 2026-10-22 — four saved turns (chat lane, Harmony harness, continued in
 * place) left the plan's 5-hour and weekly usage unchanged (6% / 32% before
 * and after). Saved plain chats stay visible in the account's history.
 */
export const SAVED_BY_DEFAULT: RegExp | null = /^gpt-5-6(?:-instant|-thinking)?$/;
export function savesByDefault(m: Pick<ResolvedModel, 'slug' | 'workMode'>): boolean {
  return !m.workMode && !!SAVED_BY_DEFAULT?.test(m.slug);
}

const norm = (s: string) => s.trim().toLowerCase();
/** "gpt-5.6-thinking" → "gpt-5-6-thinking"; strips date suffixes like -2025-10-01 */
const canon = (s: string) => norm(s).replace(/\./g, '-').replace(/-\d{4}-\d{2}-\d{2}$/, '');

const HIGH = /^(high|xhigh|max|extended|heavy|deep|ultra)$/;
const LOW = /^(none|off|minimal|low|medium|standard|light|default|auto)$/;

/**
 * OpenAI reasoning_effort spellings a client may send, and what each becomes
 * upstream. ChatGPT's chat models know two thinking efforts (standard,
 * extended); work-mode models list up to six in the work catalog: min (Light),
 * standard, extended, xhigh (Extra High), max (Heavy) and ultra.
 */
export const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export function effortTable(available: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (available.length < 2) return out; // one effort (Pro: standard only) — nothing to choose
  for (const e of OPENAI_EFFORTS) {
    const m = mapEffort(e, available);
    if (m) out[e] = m;
  }
  return out;
}

/** For each requested word, the ChatGPT efforts that satisfy it, best first. */
const EFFORT_PREFERENCE: Record<string, string[]> = {
  none: ['min', 'standard'], off: ['min', 'standard'], minimal: ['min', 'standard'], low: ['min', 'standard'], light: ['min', 'standard'],
  medium: ['standard'], default: ['standard'], auto: ['standard'],
  high: ['extended'], deep: ['extended'],
  xhigh: ['xhigh', 'extended'], 'extra-high': ['xhigh', 'extended'], extra_high: ['xhigh', 'extended'],
  max: ['max', 'xhigh', 'extended'], heavy: ['max', 'xhigh', 'extended'],
  ultra: ['ultra', 'max', 'xhigh', 'extended'],
};

/**
 * Efforts whose turns chatgpt.com hands off to a background run (stream_handoff). In a saved
 * conversation the run streams on the account websocket; in a temporary one it never produces
 * anything (measured 2026-10-22: subscribed, 7 minutes, no frames). Temporary chats get High.
 */
export const HANDOFF_EFFORTS: ReadonlySet<string> = new Set(['xhigh', 'max', 'ultra']);
export function effortForTemporaryChat(effort: string | undefined): string | undefined {
  return effort && HANDOFF_EFFORTS.has(effort) ? 'extended' : effort;
}

/** Map OpenAI reasoning_effort (or ChatGPT's own words) onto a model's effort list. */
export function mapEffort(requested: string | undefined, available: string[]): string | undefined {
  if (!requested || available.length === 0) return undefined;
  const r = norm(requested);
  if (available.includes(r)) return r;
  for (const want of EFFORT_PREFERENCE[r] ?? []) if (available.includes(want)) return want;
  if (HIGH.test(r)) return available[available.length - 1];
  if (LOW.test(r)) return available[0];
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
    // aliases never land on a metered Codex-lane twin; that lane is reachable only by its exact name
    const c = models.filter((m) => m.slug !== 'research' && !m.saved && pred(m));
    c.sort((a, b) =>
      (preferPlain ? Number(!!a.workMode || !!a.direct) - Number(!!b.workMode || !!b.direct) : 0) ||
      versionOf(b.slug) - versionOf(a.slug) ||
      Number(!!a.workMode) - Number(!!b.workMode) ||
      // among twins prefer the bare slug ("astra" → gpt-6-astra); the -wm form is reachable by exact name
      Number(!!a.workMode) - Number(!!b.workMode));
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
    saved: m?.saved || undefined,
    requested: want,
  });

  const exact = bySlug(key);
  if (exact) return finish(exact, exact.slug);

  // GPT-6 names without -wm, and the bare codenames, all reach the same chat-lane model upstream:
  // send them as "gpt-6" so the reply says what really answered (see DIRECT_MODELS)
  const chatLane = models.find((m) => m.direct && m.slug === 'gpt-6');
  if (chatLane && (/^gpt-6([-.]|$)/.test(key) && !/-wm$/.test(key) || /^(astra|luna|sol)$/.test(key))) return finish(chatLane, chatLane.slug);

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
    const plainExists = models.some((m) => inGen(m) && !m.workMode && !m.direct);
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

/**
 * POST /backend-api/f/conversation/resume — follow a turn the backend handed off
 * to a separate stream (what the ChatGPT web app does on a stream_handoff).
 */
export async function resumeConversation(creds: ConversationCreds, conversationId: string, token: string | undefined, clientSignal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(900_000); // long thinking (xhigh / max / ultra) can run for many minutes
  const signal = clientSignal ? AbortSignal.any([timeout, clientSignal]) : timeout;
  const r = await fetch(`${BASE}/backend-api/f/conversation/resume`, {
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
      ...(token ? { 'x-conduit-token': token } : {}),
      ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
    },
    body: JSON.stringify({ conversation_id: conversationId, offset: 0 }),
  });
  if (r.status !== 200 || !r.body) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 400); } catch { /* ignore */ }
    throw new UpstreamError(r.status, 'resume_failed', `conversation/resume -> ${r.status} ${detail}`.trim());
  }
  return r;
}

/** GET /backend-api/conversation/{id} — the stored conversation (messages by id, current node). */
export async function fetchConversation(creds: ConversationCreds, conversationId: string, signal?: AbortSignal): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
    signal: signal ? AbortSignal.any([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000),
    headers: {
      'user-agent': creds.ua,
      accept: '*/*',
      authorization: `Bearer ${creds.accessToken}`,
      'oai-device-id': creds.deviceId,
      'oai-language': 'en-US',
      referer: `${BASE}/c/${conversationId}`,
      ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
    },
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

/** Where the last handed-off turn's poll replies are kept (diagnostics, no secrets). */
let pollDumpPath: string | undefined;
export function setPollDumpPath(p: string): void { pollDumpPath = p; }

/**
 * A handed-off turn (long xhigh / max / ultra thinking) runs on in the background; read its
 * result from the stored conversation until the assistant's final message is there.
 */
async function* pollTurn(creds: ConversationCreds, conversationId: string, skipIds: Set<string>, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const started = Date.now();
  const log: unknown[] = [];
  const dump = () => { if (pollDumpPath) try { fs.writeFileSync(pollDumpPath, JSON.stringify(log, null, 2), { mode: 0o600 }); } catch { /* diagnostics only */ } };
  while (Date.now() - started < 20 * 60_000) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 3000));
    const { status, body } = await fetchConversation(creds, conversationId, signal).catch((err) => ({ status: 0, body: { error: String(err?.message ?? err) } }));
    const mapping = body?.mapping && typeof body.mapping === 'object' ? body.mapping : {};
    const msgs = Object.values(mapping).map((n: any) => n?.message).filter((m: any) => m && !skipIds.has(m.id));
    const assistant = msgs.filter((m: any) => m.author?.role === 'assistant');
    log.push({ t: Math.round((Date.now() - started) / 1000), status, current: body?.current_node, assistant: assistant.map((m: any) => ({ id: m.id, ct: m.content?.content_type, status: m.status, end_turn: m.end_turn, recipient: m.recipient, effort: m.metadata?.thinking_effort, text: JSON.stringify(m.content?.parts ?? m.content?.text ?? '').slice(0, 200) })) });
    if (log.length > 40) log.splice(1, 1);
    dump();
    if (status !== 200) { if (status === 404 || status === 401 || status === 403) return; continue; }
    const final = assistant.filter((m: any) => (m.content?.content_type === 'text' || m.content?.content_type === 'multimodal_text') && (!m.recipient || m.recipient === 'all') && (m.end_turn === true || m.status === 'finished_successfully'));
    const last = final[final.length - 1];
    if (!last) continue;
    const text = (Array.isArray(last.content?.parts) ? last.content.parts.filter((p: unknown) => typeof p === 'string').join('') : '').trim();
    if (!text) continue;
    if (typeof last.metadata?.model_slug === 'string') yield { modelSlug: last.metadata.model_slug };
    if (typeof last.metadata?.thinking_effort === 'string') yield { served: { effort: last.metadata.thinking_effort } };
    yield { delta: cleanVisibleText(text) };
    yield { finish: 'stop', conversationId, assistantId: last.id, kinds: ['text'] };
    return;
  }
}

/** Where the first frames of the last handed-off turn's websocket are kept (diagnostics, no secrets). */
let wsDumpPath: string | undefined;
export function setWsDumpPath(p: string): void { wsDumpPath = p; }

/** GET /backend-api/celsius/ws/user — the URL of the account's event websocket. */
async function fetchWebSocketUrl(creds: ConversationCreds, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE}/backend-api/celsius/ws/user`, {
    signal: signal ? AbortSignal.any([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000),
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
  if (r.status !== 200) throw new UpstreamError(r.status, 'ws_url_failed', `celsius/ws/user -> ${r.status}`);
  const j = (await r.json().catch(() => null)) as any;
  if (typeof j?.websocket_url !== 'string') throw new UpstreamError(502, 'ws_url_failed', 'celsius/ws/user: no websocket_url');
  return j.websocket_url;
}

/**
 * A handed-off turn (long xhigh / max / ultra thinking) streams on as a topic of the account's
 * websocket, which is what the ChatGPT web app subscribes to. Subscribe from the start of the
 * topic and turn its stream items back into an SSE body the regular parser reads.
 */
async function openTurnTopic(creds: ConversationCreds, topicId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const url = await fetchWebSocketUrl(creds, signal);
  const enc = new TextEncoder();
  const frames: string[] = [];
  const dump = () => { if (wsDumpPath) try { fs.writeFileSync(wsDumpPath, JSON.stringify({ at: new Date().toISOString(), topicId, frames }, null, 2), { mode: 0o600 }); } catch { /* diagnostics only */ } };
  const WS: any = (globalThis as any).WebSocket;
  const ws = new WS(url, { headers: { origin: BASE, 'user-agent': creds.ua } });
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    dump();
    try { ctrl.enqueue(enc.encode('data: [DONE]\n\n')); ctrl.close(); } catch { /* already closed */ }
    try { ws.close(); } catch { /* ignore */ }
  };
  const timer = setTimeout(finish, 20 * 60_000);
  signal?.addEventListener('abort', finish, { once: true });
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; }, cancel() { finish(); } });
  const handle = (m: any): void => {
    if (closed || !m || typeof m !== 'object') return;
    if (Array.isArray(m)) { for (const x of m) handle(x); return; }
    // a refused connect / subscribe would otherwise leave the request waiting for the 20-minute cap
    if ((m.id === 1 || m.id === 2) && (m.type === 'error' || m.reply?.type === 'error')) { finish(); return; }
    for (const k of ['response', 'result', 'reply']) if (m[k] && typeof m[k] === 'object') handle(m[k]);
    if (Array.isArray(m.catchups)) for (const x of m.catchups) handle(x);
    const p = m.type === 'conversation-turn-stream' ? m : m.payload?.type === 'conversation-turn-stream' ? m.payload : undefined;
    if (!p) return;
    const item = p.payload;
    if (item?.type === 'stream-item' && typeof item.encoded_item === 'string') {
      const text = item.encoded_item.endsWith('\n\n') ? item.encoded_item : `${item.encoded_item.replace(/\n*$/, '')}\n\n`;
      try { ctrl.enqueue(enc.encode(text)); } catch { /* closed */ }
    } else if (item?.type === 'done') finish();
  };
  // the web app's handshake: connect (with presence) and subscribe in one batch, as soon as the socket opens
  ws.addEventListener('open', () => ws.send(JSON.stringify([
    { id: 1, command: { type: 'connect', presence: { type: 'presence', state: 'foreground' } } },
    { id: 2, command: { type: 'subscribe', topic_id: topicId, offset: '0' } },
  ])));
  ws.addEventListener('message', (ev: any) => {
    const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
    if (frames.length < 40) frames.push(text.length > 3000 ? `${text.slice(0, 3000)}…` : text);
    try { handle(JSON.parse(text)); } catch { /* not JSON */ }
  });
  ws.addEventListener('close', finish);
  ws.addEventListener('error', finish);
  return body;
}

/** Parse a turn's stream; on a stream handoff, follow the turn on its websocket topic. */
export async function* followTurn(creds: ConversationCreds, opened: OpenedConversation, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  let handoff: StreamEvent['handoff'];
  for await (const ev of parseChatGPTSSE(opened.res.body!, opened.inputIds)) {
    if (ev.handoff) { handoff = ev.handoff; continue; }
    yield ev;
  }
  if (!handoff) return;
  let text = false;
  if (handoff.topicId) {
    const body = await openTurnTopic(creds, handoff.topicId, signal);
    for await (const ev of parseChatGPTSSE(body, opened.inputIds, { resumed: true })) {
      if (ev.delta) text = true;
      yield ev;
    }
  }
  // a saved conversation can also be read back once the background turn is done
  if (!text) yield* pollTurn(creds, handoff.conversationId, opened.inputIds, signal);
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
  /**
   * What actually served the turn, from the backend's server_ste_metadata event:
   * the experience ("chat" for the chat lane, "work" for the real work-mode
   * family), the harness ("Harmony" for temporary chats, "Codex" for saved
   * work-mode ones, which spend work credits) and the slug it ran. Unlike
   * model_slug (which echoes whatever name was sent) this tells the lanes apart.
   */
  served?: { experience?: string; harness?: string; slug?: string; effort?: string };
  /**
   * The backend moved the rest of this turn to a separate stream (long turns such as xhigh /
   * max / ultra thinking): resume it at /backend-api/f/conversation/resume with this token.
   */
  handoff?: { conversationId: string; token?: string; topicId?: string };
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
  opts: { resumed?: boolean } = {},
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let convId = '';
  let seenSlug = '';
  let seenEffort = ''; // thinking_effort the backend reports it used (message metadata)
  let finish: string | null = null;
  const messages = new Map<string, TrackedMessage>(); // visible assistant text messages, insertion-ordered
  const meta = new Map<string, any>(); // last full message object by id (for delta patches)
  const thoughts = new Map<string, string>(); // thought message id → emitted reasoning text
  let lastId = '';
  let outTail = ''; // last chars emitted overall, for joining messages
  const rawTail: string[] = []; // last raw frames, kept for diagnostics of empty turns
  let resumeToken: string | undefined; // from resume_conversation_token, needed to follow a stream handoff
  let handedOff = false;
  let turnComplete = false; // a resumed stream stays subscribed after the turn: message_stream_complete ends it

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
  const erroredIds = new Set<string>();
  const handleMessage = function* (m: any): Generator<StreamEvent> {
    if (!m || !m.id) return;
    if (skipIds.has(m.id)) return; // echo of a message we sent (history / system prompt)
    meta.set(m.id, m);
    // the backend reports some failures inside the message itself (e.g. work_usage_limit_exceeded:
    // "Your workspace is out of credits") with an empty, partially-finished text — surface them as errors
    const em = m.metadata?.error_metadata;
    if (em && typeof em === 'object' && (em.error_code || em.error_message) && !erroredIds.has(m.id)) {
      erroredIds.add(m.id);
      yield { upstreamError: { code: String(em.error_code ?? 'upstream_error'), message: String(em.error_message ?? ''), can_retry: em.can_retry } };
    }
    if (m.author?.role === 'assistant' && (m.content?.content_type === 'text' || m.content?.content_type === 'multimodal_text')) lastAssistantId = m.id;
    if (m.author?.role === 'assistant' || m.author?.role === 'tool') {
      const k = m.author.role === 'tool' ? `tool:${m.author.name ?? '?'}` : `${m.content?.content_type ?? '?'}${m.recipient && m.recipient !== 'all' ? `→${m.recipient}` : ''}`;
      kinds.add(k);
    }
    if (typeof m.metadata?.thinking_effort === 'string' && m.metadata.thinking_effort && m.metadata.thinking_effort !== seenEffort) {
      seenEffort = m.metadata.thinking_effort;
      yield { served: { effort: seenEffort } };
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
    if (v.type === 'message_stream_complete') {
      if (opts.resumed) turnComplete = true;
      return;
    }
    if (v.type === 'resume_conversation_token' && typeof v.token === 'string') {
      resumeToken = v.token;
      return;
    }
    if (v.type === 'stream_handoff') {
      if (opts.resumed) return; // a resumed stream replays the turn from the start, handoff included: read on
      const options: any[] = Array.isArray(v.options) ? v.options : [];
      const topic = options.find((o) => o?.type === 'subscribe_ws_topic' && typeof o.topic_id === 'string')?.topic_id;
      const id = typeof v.conversation_id === 'string' ? v.conversation_id : convId;
      if (id && (topic || options.some((o) => o?.type === 'resume_sse_endpoint'))) {
        handedOff = true;
        yield { handoff: { conversationId: id, token: resumeToken, ...(topic ? { topicId: topic } : {}) } };
      }
      return;
    }
    if (v.type === 'server_ste_metadata' && v.metadata && typeof v.metadata === 'object') {
      const md = v.metadata;
      const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
      yield { served: { experience: str(md.product_experience) ?? str(md.requested_model_experience), harness: str(md.harness), slug: str(md.model_slug) } };
      return;
    }

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
          if (!lastAssistantId) dumpEmptyTurn(rawTail);
          yield { finish: finish ?? 'stop', conversationId: convId || undefined, kinds: [...kinds], assistantId: lastAssistantId || undefined };
          return;
        }
        rawTail.push(data.length > 4000 ? `${data.slice(0, 4000)}…` : data);
        if (rawTail.length > 60) rawTail.shift();
        yield* handleData(data);
        if (handedOff) return; // the rest of the turn arrives on the resumed stream
        if (turnComplete) {
          for (const t of messages.values()) if (!t.final) { t.final = true; yield* emitText(t); }
          if (!lastAssistantId) dumpEmptyTurn(rawTail);
          yield { finish: finish ?? 'stop', conversationId: convId || undefined, kinds: [...kinds], assistantId: lastAssistantId || undefined };
          return;
        }
      }
    }
    // stream ended without [DONE]
    for (const t of messages.values()) if (!t.final) { t.final = true; yield* emitText(t); }
    if (!lastAssistantId) dumpEmptyTurn(rawTail);
    yield { finish: finish ?? 'stop', conversationId: convId || undefined, kinds: [...kinds], assistantId: lastAssistantId || undefined };
  } finally {
    reader.releaseLock();
    try { await body.cancel(); } catch { /* ignore */ }
  }
}

export interface UsageWindow {
  /** 0–100, as chatgpt.com's Usage page shows it */
  usedPercent: number;
  windowSeconds: number;
  /** epoch seconds when the window resets */
  resetAt: number;
}

export interface UsageSnapshot {
  fetchedAt: string;
  plan?: string;
  allowed: boolean;
  limitReached: boolean;
  /** the short window (5 hours on current plans) */
  primary?: UsageWindow;
  /** the long window (weekly on current plans) */
  secondary?: UsageWindow;
  credits?: { hasCredits: boolean; unlimited: boolean; overageLimitReached: boolean; balance?: number; approxLocalMessages?: number[]; approxCloudMessages?: number[] };
  /** per-model availability the account reports (e.g. gpt-6-astra) */
  models?: Record<string, { available: boolean; availableAt?: number }>;
}

function usageWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w.used_percent !== 'number') return undefined;
  const windowSeconds = Number(w.limit_window_seconds) || 0;
  const resetAt = Number(w.reset_at) || (Number(w.reset_after_seconds) ? Math.floor(Date.now() / 1000) + Number(w.reset_after_seconds) : 0);
  return { usedPercent: Math.max(0, Math.min(100, w.used_percent)), windowSeconds, resetAt };
}

const numPair = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : typeof v === 'number' ? [v] : undefined;

/** Parse the body of GET /backend-api/wham/usage (exported for tests). */
export function parseUsage(j: any, now = new Date()): UsageSnapshot {
  const rl = j?.rate_limit ?? {};
  const c = j?.credits;
  const models: UsageSnapshot['models'] = {};
  for (const [slug, m] of Object.entries((j?.model_usage ?? {}) as Record<string, any>)) {
    if (m && typeof m === 'object') models[slug] = { available: m.available !== false, ...(typeof m.available_at === 'number' ? { availableAt: m.available_at } : {}) };
  }
  return {
    fetchedAt: now.toISOString(),
    plan: typeof j?.plan_type === 'string' ? j.plan_type : undefined,
    allowed: rl.allowed !== false,
    limitReached: !!rl.limit_reached,
    primary: usageWindow(rl.primary_window),
    secondary: usageWindow(rl.secondary_window),
    credits: c && typeof c === 'object'
      ? {
          hasCredits: !!c.has_credits,
          unlimited: !!c.unlimited,
          overageLimitReached: !!c.overage_limit_reached,
          ...(c.balance != null && !Number.isNaN(Number(c.balance)) ? { balance: Number(c.balance) } : {}),
          ...(numPair(c.approx_local_messages) ? { approxLocalMessages: numPair(c.approx_local_messages) } : {}),
          ...(numPair(c.approx_cloud_messages) ? { approxCloudMessages: numPair(c.approx_cloud_messages) } : {}),
        }
      : undefined,
    models: Object.keys(models).length ? models : undefined,
  };
}

/** The account's usage limits — the same data as chatgpt.com → Settings → Usage. One light GET. */
export async function fetchUsage(creds: ConversationCreds): Promise<UsageSnapshot> {
  const r = await fetch(`${BASE}/backend-api/wham/usage`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      'user-agent': creds.ua,
      accept: '*/*',
      authorization: `Bearer ${creds.accessToken}`,
      'oai-device-id': creds.deviceId,
      'oai-language': 'en-US',
      referer: `${BASE}/codex/settings/usage`,
      ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
    },
  });
  if (r.status === 401) throw new UpstreamError(401, 'session_expired', 'usage -> 401');
  if (r.status !== 200) throw new UpstreamError(r.status, 'usage_failed', `usage -> ${r.status}`);
  const j = await r.json().catch(() => null);
  if (!j || typeof j !== 'object') throw new UpstreamError(502, 'usage_failed', 'usage returned no JSON');
  return parseUsage(j);
}
