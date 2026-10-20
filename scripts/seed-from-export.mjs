// Seed a session export (or raw token) into a running ShadowGate via the admin API.
// Usage: node scripts/seed-from-export.mjs <path-to-export-or-token-file> [label]
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4315';
const file = process.argv[2];
const label = process.argv[3] || 'seeded';
if (!file) {
  console.error('usage: node scripts/seed-from-export.mjs <session-file> [label]');
  process.exit(1);
}

// read admin password from .env
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const login = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD }),
});
if (!login.ok) {
  console.error('login failed:', login.status, await login.text());
  process.exit(1);
}
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const { csrf } = await login.json();

const raw = fs.readFileSync(file, 'utf8').trim();
const res = await fetch(`${BASE}/api/admin/tokens`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
  body: JSON.stringify({ label, sessionToken: raw }),
});
const body = await res.json().catch(() => ({}));
console.log(res.status, JSON.stringify(body));
if (!res.ok) process.exit(1);
console.log('Done — watch pool status: ' + BASE + '/admin');
