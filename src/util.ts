import crypto from 'node:crypto';

export const uuid = (): string => crypto.randomUUID();

export const sha256hex = (s: string): string =>
  crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self to keep timing flat, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64url');

export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

// ── HMAC-signed admin sessions ────────────────────────────────────────────

const hmacOf = (data: string, key: string): string =>
  crypto.createHmac('sha256', key).update(data).digest('base64url');

export interface SessionPayload {
  u: string; // username
  exp: number; // expiry, epoch seconds
  cs: string; // CSRF secret
  v?: number; // session version (bump to revoke all)
}

export function signSession(payload: SessionPayload, key: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmacOf(body, key)}`;
}

export function verifySession(token: string | undefined, key: string): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmacOf(body, key))) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── AES-256-GCM encryption at rest (session tokens, access tokens) ───────

const encKeyFrom = (secretKey: string): Buffer =>
  crypto.createHash('sha256').update(`shadowgate-aes:${secretKey}`).digest();

export function encryptSecret(plain: string, secretKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKeyFrom(secretKey), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptSecret(stored: string, secretKey: string): string | null {
  try {
    const [v, ivS, tagS, dataS] = stored.split(':');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKeyFrom(secretKey), Buffer.from(ivS, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── API key helpers ──────────────────────────────────────────────────────

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `sg-${crypto.randomBytes(24).toString('hex')}`;
  return { key, hash: sha256hex(key), prefix: key.slice(0, 11) };
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s step) ───────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secretB32: string, forTime = Date.now(), step = 30): string {
  const counter = Math.floor(forTime / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Verify with ±1 step tolerance (drift). */
export function totpVerify(secretB32: string, code: string): boolean {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  for (const drift of [-30_000, 0, 30_000]) {
    if (safeEqual(totpCode(secretB32, now + drift), c)) return true;
  }
  return false;
}

export const generateTotpSecret = (): string =>
  base32Encode(crypto.randomBytes(20));

// ── misc ─────────────────────────────────────────────────────────────────

export const nowIso = (): string => new Date().toISOString();

export const ipHash = (ip: string, salt: string): string =>
  sha256hex(`${salt}:${ip}`).slice(0, 16);

export const estimateTokens = (chars: number): number => Math.max(1, Math.round(chars / 4));

export function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 24) return s.slice(0, 6) + '••••••';
  return s.slice(0, 18) + '••••••••' + s.slice(-6);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
