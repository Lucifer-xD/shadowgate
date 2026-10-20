// ChatGPT session-token pool: rotation, refresh, health.
import { Store, TokenRecord } from './store.js';
import { Config } from './config.js';
import { decryptSecret, encryptSecret, nowIso, sha256hex, uuid } from './util.js';
import * as cg from './chatgpt/client.js';

const ACCESS_TTL_MS = 6 * 24 * 3600 * 1000; // refresh access tokens every 6 days
const HEALTH_INTERVAL_MS = 10 * 60 * 1000;
const HEALTH_FIRST_TICK_MS = 8 * 1000;
const RECENT_VERIFY_MS = 60 * 1000; // skip tokens verified within the last minute
const EXPIRED_RETRY_MS = 60 * 60 * 1000; // re-check expired tokens hourly (sessions get revived)

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type PoolCreds = cg.ConversationCreds;

export class TokenPool {
  private healthTimer: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private store: Store,
    private cfg: Config,
  ) {}

  /** Import tokens from SESSION_TOKENS env on boot (idempotent). */
  seedFromEnv(): number {
    let added = 0;
    for (const st of this.cfg.sessionTokens) {
      try {
        if (this.addToken(st, 'imported', false)) added++;
      } catch (err) {
        console.warn('[shadowgate] skipping SESSION_TOKENS entry:', (err as Error).message);
      }
    }
    return added;
  }

  /**
   * Add a session. `secret` may be:
   *  - the raw __Secure-next-auth.session-token value
   *  - a full session export JSON (from which we also take the matching
   *    deviceId + userAgent — critical to avoid turnstile challenges)
   */
  addToken(secret: string, label: string, verifyNow = true): boolean {
    let sessionToken = secret.trim();
    let deviceId: string | undefined;
    let ua: string | undefined;
    if (sessionToken.startsWith('{')) {
      try {
        const j = JSON.parse(sessionToken);
        sessionToken = String(j.sessionToken || '').trim();
        deviceId = j.statsigContext?.deviceId ?? j.deviceId;
        ua = j.statsigContext?.userAgent ?? j.userAgent;
      } catch {
        throw new Error('could not parse session export JSON');
      }
      if (!sessionToken) throw new Error('export JSON has no "sessionToken" field');
    }
    if (sessionToken.length < 100) throw new Error('session token looks too short to be valid');
    if (!/^[A-Za-z0-9._-]+$/.test(sessionToken)) throw new Error('session token contains unexpected characters');
    const sessionHash = sha256hex(sessionToken);
    if (this.store.tokens.some((t) => t.sessionHash === sessionHash)) return false;
    const rec: TokenRecord = {
      id: uuid(),
      label: label?.trim().slice(0, 60) || `session-${this.store.tokens.length + 1}`,
      sessionHash,
      encSession: encryptSecret(sessionToken, this.cfg.secretKey),
      encAccess: '',
      deviceId: deviceId && /^[0-9a-f-]{36}$/i.test(deviceId) ? deviceId : uuid(),
      ua: ua && ua.length > 40 && /^Mozilla\//.test(ua) ? ua : DEFAULT_UA,
      status: 'unverified',
      failCount: 0,
      createdAt: nowIso(),
    };
    this.store.tokens.push(rec);
    this.store.flush();
    if (verifyNow) void this.verify(rec).catch(() => {});
    return true;
  }

  removeToken(id: string): boolean {
    const i = this.store.tokens.findIndex((t) => t.id === id);
    if (i === -1) return false;
    this.store.tokens.splice(i, 1);
    this.store.flush();
    return true;
  }

  /** Catalog for one session, or the merged catalog of every session that reported one. */
  catalog(t?: TokenRecord): cg.ModelCatalog {
    if (t?.models?.length) return cg.withCleanWorkModels({ models: t.models, defaultModel: t.defaultModel ?? t.models[0].slug });
    const seen = new Map<string, cg.ModelInfo>();
    let defaultModel = '';
    for (const tok of this.store.tokens) {
      if (!tok.models?.length) continue;
      if (!defaultModel && tok.status === 'healthy' && tok.defaultModel) defaultModel = tok.defaultModel;
      for (const m of tok.models) if (!seen.has(m.slug)) seen.set(m.slug, m);
    }
    if (!seen.size) return cg.FALLBACK_CATALOG;
    return cg.withCleanWorkModels({ models: [...seen.values()], defaultModel: defaultModel || [...seen.keys()][0] });
  }

  /** Least-recently-used healthy token, optionally excluding ids already tried. */
  pick(exclude: Set<string> = new Set(), modelSlug?: string): TokenRecord | null {
    const now = Date.now();
    const usable = this.store.tokens.filter(
      (t) =>
        !exclude.has(t.id) &&
        (t.status === 'healthy' || t.status === 'unverified') &&
        (!t.coolUntil || t.coolUntil < now) &&
        !(modelSlug && t.modelCaps?.[modelSlug] && t.modelCaps[modelSlug] > now),
    );
    if (usable.length === 0) {
      // last resort: a session that is only cooling (not expired, not blocked) is better than refusing the request
      const cooling = this.store.tokens.filter((t) => !exclude.has(t.id) && t.status === 'cooling' && !(modelSlug && t.modelCaps?.[modelSlug] && t.modelCaps[modelSlug] > now));
      if (!cooling.length) return null;
      cooling.sort((a, b) => (a.coolUntil ?? 0) - (b.coolUntil ?? 0));
      const t = cooling[0];
      console.warn(`[pool] no healthy session — trying ${t.label} although it is cooling`);
      t.lastUsed = nowIso();
      this.store.flush();
      return t;
    }
    usable.sort((a, b) => (a.lastUsed ?? '').localeCompare(b.lastUsed ?? ''));
    const t = usable[0];
    t.lastUsed = nowIso();
    this.store.flush();
    return t;
  }

  /** Decrypt + ensure a fresh access token for a record. */
  async ensureAccess(t: TokenRecord): Promise<PoolCreds> {
    const sessionToken = decryptSecret(t.encSession, this.cfg.secretKey);
    if (!sessionToken) {
      t.status = 'expired';
      t.lastError = 'undecryptable session (SECRET_KEY changed?)';
      this.store.flush();
      throw new cg.UpstreamError(500, 'corrupt_token_record');
    }
    const last = t.lastRefresh ? Date.parse(t.lastRefresh) : 0;
    if (t.encAccess && Date.now() - last < ACCESS_TTL_MS && t.status !== 'expired') {
      const access = decryptSecret(t.encAccess, this.cfg.secretKey);
      if (access) {
        return { accessToken: access, deviceId: t.deviceId, ua: t.ua, accountId: t.accountId };
      }
    }
    const info = await cg.refreshSession(sessionToken, t.deviceId, t.ua);
    t.encAccess = encryptSecret(info.accessToken, this.cfg.secretKey);
    t.email = info.email;
    t.name = info.name;
    t.plan = info.planType;
    t.accountId = info.accountId;
    t.status = 'healthy';
    t.failCount = 0;
    t.coolUntil = undefined;
    t.lastError = undefined;
    t.lastRefresh = nowIso();
    this.store.flush();
    return { accessToken: info.accessToken, deviceId: t.deviceId, ua: t.ua, accountId: info.accountId };
  }

  markSuccess(t: TokenRecord): void {
    t.failCount = 0;
    t.coolUntil = undefined;
    t.status = 'healthy';
    t.lastError = undefined;
    this.store.flush();
  }

  markFailure(t: TokenRecord, err: unknown): void {
    const code = err instanceof cg.UpstreamError ? err.code : 0;
    const msg = err instanceof Error ? err.message : String(err);
    const cause = (err as any)?.cause?.code || (err as any)?.cause?.message;
    const detail = err instanceof cg.UpstreamError && err.detail ? ` (${err.detail})` : cause ? ` (${cause})` : '';
    t.lastError = `${code || 'net'}: ${msg}${detail}`.slice(0, 300);
    if (code === 401) {
      t.status = 'expired';
      t.encAccess = '';
    } else if (code === 429 || code === 403) {
      // throttled or challenged — back off, keep the session
      t.status = 'cooling';
      t.coolUntil = Date.now() + 3 * 60_000;
    } else if (code === 0 && /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(`${msg} ${cause ?? ''}`)) {
      // our side (or the route to chatgpt.com) blipped — not the session's fault; back off briefly only
      t.failCount++;
      if (t.failCount >= 3) {
        t.status = 'cooling';
        t.coolUntil = Date.now() + 20_000;
        t.failCount = 0;
      }
    } else {
      t.failCount++;
      if (t.failCount >= 4) {
        t.status = 'cooling';
        t.coolUntil = Date.now() + 5 * 60_000;
        t.failCount = 0;
      }
    }
    this.store.flush();
  }

  /** A specific session, if it can serve right now (continuations are bound to the account that holds the conversation). */
  pickById(id: string, modelSlug?: string): TokenRecord | null {
    const now = Date.now();
    const t = this.store.tokens.find((x) => x.id === id);
    if (!t) return null;
    if (!(t.status === 'healthy' || t.status === 'unverified')) return null;
    if (t.coolUntil && t.coolUntil > now) return null;
    if (modelSlug && t.modelCaps?.[modelSlug] && t.modelCaps[modelSlug] > now) return null;
    t.lastUsed = nowIso();
    this.store.flush();
    return t;
  }

  /** The account hit its usage cap for one model: keep the session, skip that model on it for a while. */
  markModelCap(t: TokenRecord, modelSlug: string, ms = 60 * 60_000): void {
    t.modelCaps = { ...(t.modelCaps ?? {}), [modelSlug]: Date.now() + ms };
    // forget expired entries so the record does not grow forever
    for (const [k, v] of Object.entries(t.modelCaps)) if (v < Date.now()) delete t.modelCaps[k];
    t.lastError = `model cap: ${modelSlug}`;
    this.store.flush();
  }

  /** Whether a given session is currently capped for a model. */
  isCapped(tokenId: string, modelSlug?: string): boolean {
    if (!modelSlug) return false;
    const t = this.store.tokens.find((x) => x.id === tokenId);
    return !!(t?.modelCaps?.[modelSlug] && t.modelCaps[modelSlug] > Date.now());
  }

  /** Sessions that could still serve this model right now (healthy, not cooling, not capped for it). */
  availableFor(modelSlug: string, exclude: Set<string> = new Set()): number {
    const now = Date.now();
    return this.store.tokens.filter((t) => !exclude.has(t.id) && (t.status === 'healthy' || t.status === 'unverified') && (!t.coolUntil || t.coolUntil < now) && !(t.modelCaps?.[modelSlug] && t.modelCaps[modelSlug] > now)).length;
  }

  /** Full verify: session refresh + sentinel handshake. */
  async verify(t: TokenRecord): Promise<{ ok: boolean; detail: string }> {
    try {
      const creds = await this.ensureAccess(t);
      await cg.fetchRequirements(creds.accessToken, creds.deviceId, creds.ua, creds.accountId);
      try {
        const cat = await cg.fetchModels(creds);
        if (cat.models.length) {
          t.models = cat.models;
          t.defaultModel = cat.defaultModel;
        }
      } catch (err) {
        console.warn(`[pool] model catalog for ${t.label} failed:`, (err as Error).message);
      }
      t.status = 'healthy';
      t.coolUntil = undefined;
      t.failCount = 0;
      t.lastError = undefined;
      t.lastVerified = nowIso();
      this.store.flush();
      return { ok: true, detail: `ok as ${t.email ?? 'unknown'} (${t.plan ?? '?'})` };
    } catch (err) {
      const code = err instanceof cg.UpstreamError ? err.code : 0;
      if (code === 401) {
        t.status = 'expired';
        t.encAccess = '';
      } else if (t.status === 'unverified') {
        // never worked — keep it visible but out of rotation until it does
        t.status = 'cooling';
        t.coolUntil = Date.now() + 5 * 60_000;
      }
      t.lastVerified = nowIso();
      t.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.store.flush();
      return { ok: false, detail: t.lastError };
    }
  }

  startHealthLoop(): void {
    const tick = async () => {
      if (this.stopped) return;
      const now = Date.now();
      for (const t of this.store.tokens) {
        if (this.stopped) return;
        const lastVerified = t.lastVerified ? Date.parse(t.lastVerified) : 0;
        if (now - lastVerified < RECENT_VERIFY_MS) continue;
        if (t.status === 'cooling' && t.coolUntil && t.coolUntil > now) continue;
        if (t.status === 'expired' && now - lastVerified < EXPIRED_RETRY_MS) continue;
        await this.verify(t).catch(() => {});
      }
    };
    this.firstTick = setTimeout(() => void tick(), HEALTH_FIRST_TICK_MS);
    this.firstTick.unref?.();
    this.healthTimer = setInterval(() => void tick(), HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.firstTick) clearTimeout(this.firstTick);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.firstTick = null;
    this.healthTimer = null;
  }
}
