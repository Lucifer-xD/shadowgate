// Admin panel API — hardened: bcrypt login, per-IP lockout, signed
// HttpOnly sessions, CSRF double-submit, optional TOTP, IP allowlist, audit.
import type { Express, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { Store, TokenRecord, ApiKeyRecord } from './store.js';
import { Config } from './config.js';
import { TokenPool } from './pool.js';
import {
  generateApiKey,
  generateTotpSecret,
  ipHash,
  nowIso,
  safeEqual,
  signSession,
  totpVerify,
  uuid,
  verifySession,
} from './util.js';

const SESSION_HOURS = 8;
const COOKIE = 'sg_admin';
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const PENDING_TOTP_TTL_MS = 10 * 60_000;

// bcrypt hash of a random string — compared against when the username is
// unknown so a wrong username costs the same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(uuid(), 12);

// ── helpers ──────────────────────────────────────────────────────────────

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Client IP — honours express "trust proxy" (set via TRUST_PROXY) so lockouts
 *  and allowlists apply to the real visitor, not to nginx/Cloudflare. */
const clientIp = (req: Request): string =>
  (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');

function ipAllowed(ip: string, allowlist: string[] | null): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((rule) => {
    if (rule === ip) return true;
    const [base, bitsStr] = rule.split('/');
    if (!bitsStr) return false;
    const bits = parseInt(bitsStr, 10);
    const a = ip.split('.').map(Number);
    const b = base.split('.').map(Number);
    if (a.length !== 4 || b.length !== 4 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
    const toBits = (o: number[]) => o.map((x) => x.toString(2).padStart(8, '0')).join('');
    return toBits(a).slice(0, bits) === toBits(b).slice(0, bits);
  });
}

interface LockState {
  fails: number;
  lockUntil: number;
}
const loginLocks = new Map<string, LockState>();

function registerFailure(ip: string): void {
  const st = loginLocks.get(ip) ?? { fails: 0, lockUntil: 0 };
  st.fails++;
  if (st.fails >= LOCK_AFTER) {
    st.lockUntil = Date.now() + LOCK_MINUTES * 60_000;
    st.fails = 0;
  }
  loginLocks.set(ip, st);
}

// forget stale lock entries so the map can't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, st] of loginLocks) if (st.lockUntil < now && st.fails === 0) loginLocks.delete(ip);
}, 30 * 60_000).unref();

let pendingTotp: { secret: string; expires: number } | null = null;

function audit(store: Store, cfg: Config, req: Request, action: string, detail: string): void {
  store.logAudit({ ts: nowIso(), action, detail, ipHash: ipHash(clientIp(req), cfg.secretKey) });
}

// ── middleware ───────────────────────────────────────────────────────────

export function requireAdmin(store: Store, cfg: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!ipAllowed(clientIp(req), cfg.adminIpAllowlist)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const payload = verifySession(parseCookies(req)[COOKIE], cfg.secretKey);
    if (!payload || payload.u !== store.settings.adminUser) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (payload.v !== store.settings.sessionVersion) {
      res.status(401).json({ error: 'session_revoked' });
      return;
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, payload.cs)) {
        res.status(403).json({ error: 'csrf_failed' });
        return;
      }
    }
    (req as any).adminSession = payload;
    next();
  };
}

// ── mount ────────────────────────────────────────────────────────────────

export function mountAdmin(app: Express, store: Store, cfg: Config, pool: TokenPool): void {
  const auth = requireAdmin(store, cfg);

  // ── login / session ────────────────────────────────────────────────────

  app.post('/api/admin/login', (req, res) => {
    if (!ipAllowed(clientIp(req), cfg.adminIpAllowlist)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const ip = clientIp(req);
    const lock = loginLocks.get(ip);
    if (lock && lock.lockUntil > Date.now()) {
      const mins = Math.ceil((lock.lockUntil - Date.now()) / 60_000);
      res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} min.` });
      return;
    }
    const { username, password, totp } = req.body ?? {};
    const s = store.settings;
    const userOk =
      typeof username === 'string' && typeof password === 'string' &&
      safeEqual(username.trim().toLowerCase(), s.adminUser);
    let valid = false;
    try {
      // always run bcrypt so timing doesn't reveal whether the username exists
      valid = bcrypt.compareSync(typeof password === 'string' ? password : '', userOk ? s.adminHash : DUMMY_HASH) && userOk;
    } catch { /* corrupt hash */ }
    if (!valid) {
      registerFailure(ip);
      audit(store, cfg, req, 'login_fail', userOk ? 'bad password' : 'bad username');
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    if (s.totpSecret) {
      if (typeof totp !== 'string' || !totp.trim()) {
        // password accepted, code missing — don't count as a strike
        res.status(401).json({ error: 'Enter your 2FA code.', totpRequired: true });
        return;
      }
      if (!totpVerify(s.totpSecret, totp)) {
        registerFailure(ip);
        audit(store, cfg, req, 'login_fail', 'bad 2fa code');
        res.status(401).json({ error: 'Invalid 2FA code.', totpRequired: true });
        return;
      }
    }
    loginLocks.delete(ip);
    const cs = uuid();
    const token = signSession(
      { u: s.adminUser, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600, cs, v: s.sessionVersion },
      cfg.secretKey,
    );
    res.setHeader(
      'set-cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${cfg.cookieSecure ? '; Secure' : ''}`,
    );
    audit(store, cfg, req, 'login_ok', s.adminUser);
    res.json({
      ok: true,
      csrf: cs,
      username: s.adminUser,
      mustChangePw: s.mustChangePw,
      totpEnabled: !!s.totpSecret,
    });
  });

  app.post('/api/admin/logout', auth, (req, res) => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cfg.cookieSecure ? '; Secure' : ''}`);
    audit(store, cfg, req, 'logout', store.settings.adminUser);
    res.json({ ok: true });
  });

  app.get('/api/admin/session', (req, res) => {
    if (!ipAllowed(clientIp(req), cfg.adminIpAllowlist)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const payload = verifySession(parseCookies(req)[COOKIE], cfg.secretKey);
    if (!payload || payload.u !== store.settings.adminUser || payload.v !== store.settings.sessionVersion) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({
      authenticated: true,
      username: payload.u,
      csrf: payload.cs,
      mustChangePw: store.settings.mustChangePw,
      totpEnabled: !!store.settings.totpSecret,
      brandName: store.settings.brandName,
    });
  });

  app.get('/api/admin/models', auth, (_req, res) => {
    const cat = pool.catalog();
    res.json({ defaultModel: cat.defaultModel, models: cat.models.filter((m) => !/-wm$/i.test(m.slug)).map((m) => ({ ...m, clean: !!m.upstreamSlug })) });
  });

  // ── dashboard stats ───────────────────────────────────────────────────

  app.get('/api/admin/stats', auth, (_req, res) => {
    const now = Date.now();
    const dayAgo = now - 24 * 3600_000;
    const recent = store.requests.filter((r) => Date.parse(r.ts) >= dayAgo);
    const okCount = recent.filter((r) => r.status < 400).length;
    const avgLatency = recent.length
      ? Math.round(recent.reduce((a, r) => a + r.latencyMs, 0) / recent.length)
      : 0;

    const hourly: Array<{ h: string; count: number; errors: number }> = [];
    for (let i = 23; i >= 0; i--) {
      const lo = now - (i + 1) * 3600_000;
      const hi = now - i * 3600_000;
      const inHour = store.requests.filter((r) => {
        const t = Date.parse(r.ts);
        return t >= lo && t < hi;
      });
      hourly.push({
        h: new Date(hi).toISOString().slice(11, 16),
        count: inHour.length,
        errors: inHour.filter((r) => r.status >= 400).length,
      });
    }

    const byModel = new Map<string, number>();
    for (const r of recent) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    const models = [...byModel.entries()].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count);

    const tokens = store.tokens.map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      email: t.email ? t.email.replace(/^(.).*(@.*)$/, '$1***$2') : undefined,
      plan: t.plan,
    }));
    const keyNames = new Map(store.keys.map((k) => [k.id, k.name]));
    const byKey = new Map<string, number>();
    for (const r of recent) byKey.set(r.keyId, (byKey.get(r.keyId) ?? 0) + 1);
    const topKeys = [...byKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ name: keyNames.get(id) ?? id.slice(0, 8), count }));

    res.json({
      requests24h: recent.length,
      errors24h: recent.length - okCount,
      avgLatency,
      totalRequests: store.requests.length,
      activeKeys: store.keys.filter((k) => k.enabled).length,
      totalKeys: store.keys.length,
      poolHealthy: store.tokens.filter((t) => t.status === 'healthy').length,
      poolTotal: store.tokens.length,
      pool: tokens,
      hourly,
      models,
      topKeys,
      recent: [...store.requests].slice(-8).reverse(),
      uptimeSec: Math.round(process.uptime()),
      version: cfg.version,
    });
  });

  // ── API keys ──────────────────────────────────────────────────────────

  app.get('/api/admin/keys', auth, (_req, res) => {
    res.json({
      keys: store.keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        enabled: k.enabled,
        rpm: k.rpm,
        rpd: k.rpd,
        totalRequests: k.totalRequests,
        totalChars: k.totalChars,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
      })),
    });
  });

  app.post('/api/admin/keys', auth, (req, res) => {
    const { name, rpm, rpd } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 60) {
      res.status(400).json({ error: 'Name required (max 60 chars).' });
      return;
    }
    const mk = (v: unknown, def: number) =>
      Number.isInteger(v) && (v as number) > 0 && (v as number) <= 10000 ? (v as number) : def;
    const { key, hash, prefix } = generateApiKey();
    const rec: ApiKeyRecord = {
      id: uuid(),
      name: name.trim(),
      hash,
      prefix,
      enabled: true,
      rpm: mk(rpm, cfg.defaultKeyRpm),
      rpd: mk(rpd, cfg.defaultKeyRpd),
      totalRequests: 0,
      totalChars: 0,
      createdAt: nowIso(),
    };
    store.keys.push(rec);
    store.flush();
    audit(store, cfg, req, 'key_create', rec.name);
    res.json({ ok: true, key, id: rec.id }); // full key shown exactly once
  });

  app.patch('/api/admin/keys/:id', auth, (req, res) => {
    const rec = store.keys.find((k) => k.id === req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { enabled, name, rpm, rpd } = req.body ?? {};
    if (typeof enabled === 'boolean') rec.enabled = enabled;
    if (typeof name === 'string' && name.trim()) rec.name = name.trim().slice(0, 60);
    if (Number.isInteger(rpm) && (rpm as number) > 0) rec.rpm = rpm as number;
    if (Number.isInteger(rpd) && (rpd as number) > 0) rec.rpd = rpd as number;
    store.flush();
    audit(store, cfg, req, 'key_update', rec.name);
    res.json({ ok: true });
  });

  app.delete('/api/admin/keys/:id', auth, (req, res) => {
    const i = store.keys.findIndex((k) => k.id === req.params.id);
    if (i === -1) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const [removed] = store.keys.splice(i, 1);
    store.flush();
    audit(store, cfg, req, 'key_delete', removed.name);
    res.json({ ok: true });
  });

  // ── session tokens ────────────────────────────────────────────────────

  app.get('/api/admin/tokens', auth, (_req, res) => {
    res.json({
      tokens: store.tokens.map((t: TokenRecord) => ({
        id: t.id,
        label: t.label,
        status: t.status,
        email: t.email ? t.email.replace(/^(.).*(@.*)$/, '$1***$2') : undefined,
        name: t.name,
        plan: t.plan,
        failCount: t.failCount,
        coolUntil: t.coolUntil && t.coolUntil > Date.now() ? t.coolUntil : undefined,
        deviceId: t.deviceId.slice(0, 8) + '…',
        lastRefresh: t.lastRefresh,
        lastVerified: t.lastVerified,
        models: (t.models ?? []).map((m) => ({ slug: m.slug, title: m.title, reasoning: m.reasoning, efforts: m.efforts, workMode: !!m.workMode })),
        defaultModel: t.defaultModel,
        lastUsed: t.lastUsed,
        lastError: t.lastError,
        createdAt: t.createdAt,
      })),
    });
  });

  app.post('/api/admin/tokens', auth, (req, res) => {
    const { label, sessionToken } = req.body ?? {};
    if (typeof sessionToken !== 'string' || sessionToken.trim().length < 100) {
      res.status(400).json({ error: 'sessionToken must be a full __Secure-next-auth.session-token value.' });
      return;
    }
    try {
      const added = pool.addToken(sessionToken, typeof label === 'string' ? label : '');
      audit(store, cfg, req, added ? 'token_add' : 'token_dup', typeof label === 'string' ? label : '');
      res.json({ ok: added, message: added ? 'Token added — verifying in background.' : 'Token already in pool.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid token' });
    }
  });

  app.patch('/api/admin/tokens/:id', auth, (req, res) => {
    const t = store.tokens.find((x) => x.id === req.params.id);
    if (!t) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { label } = req.body ?? {};
    if (typeof label === 'string' && label.trim()) t.label = label.trim().slice(0, 60);
    store.flush();
    audit(store, cfg, req, 'token_update', t.label);
    res.json({ ok: true });
  });

  app.post('/api/admin/tokens/:id/verify', auth, async (req, res) => {
    const t = store.tokens.find((x) => x.id === req.params.id);
    if (!t) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const result = await pool.verify(t);
    audit(store, cfg, req, 'token_verify', `${t.label}: ${result.detail}`);
    res.json(result);
  });

  app.delete('/api/admin/tokens/:id', auth, (req, res) => {
    const t = store.tokens.find((x) => x.id === req.params.id);
    if (!t) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    pool.removeToken(t.id);
    audit(store, cfg, req, 'token_delete', t.label);
    res.json({ ok: true });
  });

  // ── logs ──────────────────────────────────────────────────────────────

  app.get('/api/admin/logs', auth, (req, res) => {
    const filter = String(req.query.status ?? 'all');
    const model = String(req.query.model ?? '');
    let items = [...store.requests].reverse();
    if (filter === 'error') items = items.filter((r) => r.status >= 400);
    if (filter === 'ok') items = items.filter((r) => r.status < 400);
    if (model && model !== 'all') items = items.filter((r) => r.model === model);
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    res.json({
      items: items.slice(0, limit).map((r) => ({
        ...r,
        keyName: store.keys.find((k) => k.id === r.keyId)?.name ?? r.keyId.slice(0, 8),
      })),
      total: items.length,
    });
  });

  app.get('/api/admin/audit', auth, (_req, res) => {
    res.json({ items: [...store.audit].reverse().slice(0, 200) });
  });

  // ── settings / security ───────────────────────────────────────────────

  app.get('/api/admin/settings', auth, (_req, res) => {
    const s = store.settings;
    res.json({
      brandName: s.brandName,
      username: s.adminUser,
      totpEnabled: !!s.totpSecret,
      mustChangePw: s.mustChangePw,
      recordApi: !!s.recordApi,
      defaultRpm: cfg.defaultKeyRpm,
      defaultRpd: cfg.defaultKeyRpd,
      publicBaseUrl: cfg.publicBaseUrl,
      trustProxy: cfg.trustProxy,
      ipAllowlist: cfg.adminIpAllowlist ?? [],
      version: cfg.version,
    });
  });

  app.post('/api/admin/settings', auth, (req, res) => {
    const { brandName, recordApi } = req.body ?? {};
    if (typeof brandName === 'string' && brandName.trim()) store.settings.brandName = brandName.trim().slice(0, 40);
    if (typeof recordApi === 'boolean') {
      store.settings.recordApi = recordApi;
      audit(store, cfg, req, 'settings_record_api', recordApi ? 'on' : 'off');
    }
    store.flush();
    res.json({ ok: true });
  });

  app.post('/api/admin/password', auth, (req, res) => {
    const { current, next } = req.body ?? {};
    if (typeof current !== 'string' || typeof next !== 'string' || next.length < 10 || next.length > 200) {
      res.status(400).json({ error: 'New password must be 10–200 characters.' });
      return;
    }
    if (next === current) {
      res.status(400).json({ error: 'New password must differ from the current one.' });
      return;
    }
    if (!bcrypt.compareSync(current, store.settings.adminHash)) {
      res.status(401).json({ error: 'Current password is wrong.' });
      return;
    }
    store.settings.adminHash = bcrypt.hashSync(next, 12);
    store.settings.mustChangePw = false;
    store.settings.sessionVersion++; // revoke all other sessions
    store.flush();
    audit(store, cfg, req, 'password_change', store.settings.adminUser);
    res.json({ ok: true, note: 'All other sessions were revoked.' });
  });

  app.post('/api/admin/totp/setup', auth, (req, res) => {
    if (store.settings.totpSecret) {
      res.status(400).json({ error: '2FA already enabled. Disable it first.' });
      return;
    }
    const secret = generateTotpSecret();
    pendingTotp = { secret, expires: Date.now() + PENDING_TOTP_TTL_MS };
    const otpauth = `otpauth://totp/ShadowGate:${encodeURIComponent(store.settings.adminUser)}?secret=${secret}&issuer=ShadowGate&algorithm=SHA1&digits=6&period=30`;
    audit(store, cfg, req, 'totp_setup', 'pending');
    res.json({ secret, otpauth });
  });

  app.post('/api/admin/totp/enable', auth, (req, res) => {
    if (!pendingTotp || pendingTotp.expires < Date.now()) {
      pendingTotp = null;
      res.status(400).json({ error: 'Run setup first (the pending secret expires after 10 minutes).' });
      return;
    }
    const { code } = req.body ?? {};
    if (typeof code !== 'string' || !totpVerify(pendingTotp.secret, code)) {
      res.status(400).json({ error: 'Invalid code — try the next one.' });
      return;
    }
    store.settings.totpSecret = pendingTotp.secret;
    pendingTotp = null;
    store.flush();
    audit(store, cfg, req, 'totp_enable', store.settings.adminUser);
    res.json({ ok: true });
  });

  app.post('/api/admin/totp/disable', auth, (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !bcrypt.compareSync(password, store.settings.adminHash)) {
      res.status(401).json({ error: 'Password required to disable 2FA.' });
      return;
    }
    store.settings.totpSecret = null;
    pendingTotp = null;
    store.flush();
    audit(store, cfg, req, 'totp_disable', store.settings.adminUser);
    res.json({ ok: true });
  });

  app.post('/api/admin/sessions/revoke', auth, (req, res) => {
    store.settings.sessionVersion++;
    store.flush();
    audit(store, cfg, req, 'sessions_revoke', 'all');
    res.json({ ok: true, note: 'All admin sessions revoked — log in again.' });
  });
}
