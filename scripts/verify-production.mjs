// Final production verification via https://ai.shadowvpn.live
import fs from 'node:fs';

const BASE = 'https://ai.shadowvpn.live';
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const ADMIN_PW = process.argv[2];

// 1. healthz
const h = await fetch(`${BASE}/healthz`);
console.log(`[1] healthz          ${h.status} ${(await h.text()).slice(0, 60)}`);

// 2. landing
const land = await fetch(BASE);
const html = await land.text();
console.log(`[2] landing          ${land.status} hasHero=${html.includes('private gate')} title=${html.match(/<title>(.*?)<\/title>/)?.[1]}`);

// 3. admin login (via domain)
const login = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: ADMIN_PW }),
});
console.log(`[3] admin login      ${login.status} ok=${(await login.json().catch(() => ({}))).ok}`);
const setCookie = login.headers.get('set-cookie') || '';
console.log(`    cookie flags     ${setCookie.split(';').map((s) => s.trim().split('=')[0]).join(' | ')}`);

// 4. create key + real completion through the domain
const cookie = setCookie.split(';')[0];
const csrf = (await (await fetch(`${BASE}/api/admin/session`, { headers: { cookie } })).json()).csrf;
const key = await (await fetch(`${BASE}/api/admin/keys`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
  body: JSON.stringify({ name: 'production-check' }),
})).json();

const t0 = Date.now();
const comp = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Reply with exactly: SHADOWGATE-PRODUCTION-OK' }] }),
});
const cj = await comp.json().catch(() => null);
console.log(`[4] completion       ${comp.status} in ${Date.now() - t0}ms -> ${JSON.stringify(cj?.choices?.[0]?.message?.content)}`);

// 5. streaming through the domain
const t1 = Date.now();
const stream = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'Say: streaming works' }] }),
});
let out = '';
if (stream.status === 200) {
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      if (d === '[DONE]') { buf = 'x'; break; }
      try { out += JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch { /* skip */ }
    }
    if (buf === 'x') break;
  }
  console.log(`[5] streaming        200 in ${Date.now() - t1}ms -> "${out}"`);
} else {
  console.log(`[5] streaming        ${stream.status} FAIL`);
}

console.log('\nPRODUCTION VERIFICATION ' + (comp.status === 200 && out ? 'PASSED ✓' : 'INCOMPLETE'));
