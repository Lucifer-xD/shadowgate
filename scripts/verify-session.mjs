// Verify a ChatGPT session export or raw session token against chatgpt.com.
// Usage:
//   node scripts/verify-session.mjs ./session-export.json
//   node scripts/verify-session.mjs   (reads SESSION_TOKEN env)
// Prints masked output only.
import fs from 'node:fs';
import crypto from 'node:crypto';

const arg = process.argv[2];
let raw = '';
if (arg) {
  raw = fs.readFileSync(arg, 'utf8').trim();
} else if (process.env.SESSION_TOKEN) {
  raw = process.env.SESSION_TOKEN.trim();
} else {
  console.error('usage: node scripts/verify-session.mjs <file-or-token> [or set SESSION_TOKEN]');
  process.exit(1);
}

let sessionToken = raw;
let deviceId = crypto.randomUUID();
let ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let accessToken = null;
if (raw.startsWith('{')) {
  const j = JSON.parse(raw);
  sessionToken = j.sessionToken || '';
  accessToken = j.accessToken || null;
  if (j.statsigContext?.deviceId) deviceId = j.statsigContext.deviceId;
  if (j.statsigContext?.userAgent) ua = j.statsigContext.userAgent;
}
const mask = (s) => (s ? s.slice(0, 14) + '…' + s.slice(-6) + ` (len=${s.length})` : 'MISSING');
console.log('[*] sessionToken:', mask(sessionToken));
console.log('[*] deviceId   :', deviceId);

const r = await fetch('https://chatgpt.com/api/auth/session', {
  headers: {
    'user-agent': ua,
    accept: '*/*',
    cookie: `__Secure-next-auth.session-token=${sessionToken}`,
    'oai-device-id': deviceId,
  },
});
const j = await r.json().catch(() => null);
console.log(`[1] auth/session     status=${r.status} accessToken=${!!j?.accessToken} expires=${j?.expires ?? 'n/a'} plan=${j?.account?.planType ?? 'n/a'}`);
const at = j?.accessToken || accessToken;
if (!at) { console.log('✗ session is dead — re-export from browser'); process.exit(1); }

const me = await fetch('https://chatgpt.com/backend-api/me?export_decrypt=false', {
  headers: { 'user-agent': ua, authorization: `Bearer ${at}`, 'oai-device-id': deviceId },
});
const mej = await me.json().catch(() => null);
console.log(`[2] backend-api/me   status=${me.status} account=${mej?.email?.slice(0, 3) ? mej.email.slice(0, 3) + '***' : 'n/a'}`);
console.log(me.status === 200 ? '✓ session valid — ready for ShadowGate' : '✗ token not accepted');
process.exit(me.status === 200 ? 0 : 1);
