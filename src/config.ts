import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Config {
  port: number;
  bindHost: string;
  publicBaseUrl: string;
  secretKey: string;
  adminUsername: string;
  adminPassword: string | null;
  sessionTokens: string[];
  defaultKeyRpm: number;
  defaultKeyRpd: number;
  /** 0 = direct, n = number of trusted reverse-proxy hops (express "trust proxy"). */
  trustProxy: number;
  adminIpAllowlist: string[] | null;
  dataDir: string;
  webRoot: string;
  cookieSecure: boolean;
  version: string;
}

function envInt(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** TRUST_PROXY accepts 0/1/true/false or an explicit hop count. */
function envTrustProxy(): number {
  const raw = (process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false') return 0;
  if (raw === 'true') return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Load .env file (KEY=VALUE lines) into process.env without overriding. */
export function loadDotEnv(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env — fine
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function readVersion(rootDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(rootDir: string): Config {
  loadDotEnv(path.join(rootDir, '.env'));

  let secretKey = process.env.SECRET_KEY?.trim() || '';
  if (!secretKey) {
    // Dev convenience: derive an ephemeral key. Production MUST set SECRET_KEY
    // (the deploy script does); warn loudly.
    secretKey = crypto.randomBytes(32).toString('hex');
    console.warn('[shadowgate] WARNING: SECRET_KEY not set — generated an ephemeral key. Admin sessions and encrypted tokens will not survive restarts.');
  }

  const publicBaseUrl = (process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:4315').replace(/\/+$/, '');

  const sessionTokens = (process.env.SESSION_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 20);

  return {
    port: envInt('PORT', 4315),
    bindHost: process.env.BIND_HOST?.trim() || '0.0.0.0',
    publicBaseUrl,
    secretKey,
    adminUsername: (process.env.ADMIN_USERNAME?.trim() || 'admin').toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD?.trim() || null,
    sessionTokens,
    defaultKeyRpm: envInt('DEFAULT_KEY_RPM', 120),
    defaultKeyRpd: envInt('DEFAULT_KEY_RPD', 20000),
    trustProxy: envTrustProxy(),
    adminIpAllowlist: process.env.ADMIN_IP_ALLOWLIST
      ? process.env.ADMIN_IP_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
      : null,
    dataDir: path.join(rootDir, 'data'),
    webRoot: path.join(rootDir, 'web'),
    cookieSecure: publicBaseUrl.startsWith('https://'),
    version: readVersion(rootDir),
  };
}
