// ShadowGate — entrypoint.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';
import { loadConfig, Config } from './config.js';
import * as cg from './chatgpt/client.js';
import { allPersisted, sweepExpired, type ContinuationEntry } from './continuation.js';
import { Store, Settings } from './store.js';
import { TokenPool } from './pool.js';
import { mountGateway } from './gateway.js';
import { mountAdmin, requireAdmin } from './admin.js';
import { ChatStore, mountChats } from './chats.js';
import { warmBuildId } from './chatgpt/pow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const cfg: Config = loadConfig(rootDir);
fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });

// Refuse to run with amnesia: everything (keys, sessions, settings) lives in data/,
// and a read-only data dir would silently lose every change. Typical cause: a Docker
// bind mount owned by the host user while the container runs as "shadowgate".
try {
  const probe = path.join(cfg.dataDir, '.write-test');
  fs.writeFileSync(probe, String(process.pid));
  fs.unlinkSync(probe);
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code ?? 'error';
  console.error(`[shadowgate] FATAL: the data directory is not writable (${code}): ${cfg.dataDir}`);
  console.error('[shadowgate] The store (API keys, sessions, settings) would be lost on every change, so the gateway will not start.');
  console.error('[shadowgate] Fix: make the directory writable by the user running the gateway. In Docker, use the named volume from docker-compose.yml,');
  console.error('[shadowgate] or for a bind mount run:  sudo chown -R 10001:10001 ./data   (10001 is the "shadowgate" user inside the image).');
  process.exit(1);
}

// ── settings bootstrap ───────────────────────────────────────────────────

let generatedPassword: string | null = null;
const freshSettings = (): Settings => {
  let password = cfg.adminPassword ?? '';
  if (!password) {
    password = crypto.randomBytes(18).toString('base64url');
    generatedPassword = password;
  }
  return {
    adminUser: cfg.adminUsername,
    adminHash: bcrypt.hashSync(password, 12),
    mustChangePw: !!generatedPassword,
    sessionVersion: 1,
    totpSecret: null,
    ipSalt: crypto.randomBytes(16).toString('hex'),
    brandName: 'ShadowGate',
  };
};

const store = new Store(cfg.dataDir, freshSettings);
const chats = new ChatStore(cfg.dataDir);
if (generatedPassword) store.flush();

// ADMIN_PASSWORD_RESET=1 + ADMIN_PASSWORD=new → force password change
if (process.env.ADMIN_PASSWORD_RESET === '1' && cfg.adminPassword) {
  store.settings.adminHash = bcrypt.hashSync(cfg.adminPassword, 12);
  store.settings.mustChangePw = false;
  store.settings.sessionVersion++;
  store.flushNow();
  console.log('[shadowgate] Admin password was reset from environment.');
}

// ── services ─────────────────────────────────────────────────────────────

const pool = new TokenPool(store, cfg);
const imported = pool.seedFromEnv();
if (imported > 0) console.log(`[shadowgate] Imported ${imported} session token(s) from env.`);
pool.startHealthLoop();
void warmBuildId();

// ── http app ─────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
if (cfg.trustProxy > 0) app.set('trust proxy', cfg.trustProxy);

// security headers
app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  next();
});

app.get('/healthz', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.json({ ok: true, uptime: Math.round(process.uptime()), version: cfg.version });
});

app.use(express.json({ limit: '24mb' }));

mountGateway(app, store, cfg, pool, chats);
mountAdmin(app, store, cfg, pool);
mountChats(app, requireAdmin(store, cfg), chats, store, pool);

// static web (landing, docs, admin SPA)
app.use(
  express.static(cfg.webRoot, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      else res.setHeader('cache-control', 'public, max-age=3600');
    },
  }),
);
app.use('/admin', (_req, res) => {
  res.setHeader('cache-control', 'no-cache');
  res.sendFile(path.join(cfg.webRoot, 'admin', 'index.html'));
});

// fallthrough 404
app.use((req, res) => {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/api/')) {
    res.status(404).json({ error: { message: `Unknown endpoint ${req.method} ${req.path}`, type: 'invalid_request_error', param: null, code: null } });
  } else {
    res.status(404).sendFile(path.join(cfg.webRoot, '404.html'));
  }
});

// error handler — malformed JSON, oversized bodies, anything thrown in a route
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 500) console.error('[shadowgate] unhandled error:', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  const message =
    status === 400 ? 'Malformed JSON body.' :
    status === 413 ? 'Request body too large (24 MB limit).' :
    status >= 500 ? 'Internal server error.' : (err?.message || 'Request failed.');
  res.setHeader('cache-control', 'no-store');
  if (req.path.startsWith('/v1/')) {
    res.status(status).json({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: null } });
  } else {
    res.status(status).json({ error: message });
  }
});

const server = app.listen(cfg.port, cfg.bindHost, () => {
  const url = `http://${cfg.bindHost === '0.0.0.0' ? 'localhost' : cfg.bindHost}:${cfg.port}`;
  console.log('');
  console.log('  ███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗ ██████╗  █████╗ ████████╗███████╗');
  console.log('  ██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝');
  console.log('  ███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║██║  ███╗███████║   ██║   █████╗  ');
  console.log('  ╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║██║   ██║██╔══██║   ██║   ██╔══╝  ');
  console.log('  ███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║   ██║   ███████╗');
  console.log('  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝');
  console.log(`  v${cfg.version} — a private gate between your tools and ChatGPT`);
  console.log('');
  console.log(`  ➜ gateway : ${url}/v1`);
  console.log(`  ➜ admin   : ${url}/admin`);
  console.log(`  ➜ docs    : ${url}/docs`);
  if (cfg.trustProxy > 0) console.log(`  ➜ proxy   : trusting ${cfg.trustProxy} hop(s)`);
  if (generatedPassword) {
    console.log('');
    console.log('  ┌──────────────── FIRST BOOT ─────────────────┐');
    console.log('  │ A random admin password was generated:      │');
    console.log('  │                                             │');
    console.log(`  │   username: ${store.settings.adminUser.padEnd(30)}│`);
    console.log(`  │   password: ${generatedPassword.padEnd(30)}│`);
    console.log('  │                                             │');
    console.log('  │ Save it now — it will not be shown again.   │');
    console.log('  └─────────────────────────────────────────────┘');
  }
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[shadowgate] port ${cfg.port} is already in use (set PORT to change it).`);
  } else {
    console.error('[shadowgate] server error:', err);
  }
  process.exit(1);
});

// keep long SSE responses alive through the proxy
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

// ── continuation housekeeping: hide saved work-mode conversations once idle ──
async function hideConversations(entries: ContinuationEntry[]): Promise<void> {
  let hidden = 0;
  for (const e of entries) {
    const t = store.tokens.find((x) => x.id === e.tokenId);
    if (!t) continue;
    try {
      const creds = await pool.ensureAccess(t);
      const ok = await cg.hideConversation(creds, e.conversationId);
      if (ok) hidden++;
      else console.warn(`[continuation] could not hide conversation ${e.conversationId} on ${t.label}`);
    } catch (err) {
      console.warn(`[continuation] hide failed on ${t.label}:`, (err as Error).message);
    }
  }
  if (hidden) console.log(`[continuation] hid ${hidden} idle work-mode conversation(s) from the account history`);
}
setInterval(() => { void hideConversations(sweepExpired()); }, 60_000).unref();

// ── graceful shutdown (systemd sends SIGTERM; Ctrl+C sends SIGINT) ──────
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shadowgate] ${signal} received — flushing store and closing server`);
  pool.stop();
  store.flushNow();
  chats.flushNow();
  const pending = allPersisted();
  const done = pending.length ? hideConversations(pending).catch(() => undefined) : Promise.resolve();
  server.close(() => { void done.finally(() => process.exit(0)); });
  // don't wait forever on open SSE streams or upstream calls
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[shadowgate] uncaught exception:', err);
  store.flushNow();
  chats.flushNow();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[shadowgate] unhandled rejection:', reason);
});
