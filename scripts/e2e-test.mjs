// ShadowGate end-to-end test: login → create key → models → completion (json + stream)
const BASE = process.env.BASE_URL || 'http://localhost:4315';
const fs = await import('node:fs');

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

let cookie = '';
let csrf = '';

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['content-type'] = 'application/json';
  if (opts.method) headers['x-csrf-token'] = csrf;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// 1. login
const login = await call('/api/admin/login', {
  method: 'POST',
  body: JSON.stringify({ username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD }),
});
csrf = login.json?.csrf;
console.log(`[1] login          ${login.status} ok=${!!login.json?.ok} csrf=${csrf ? 'yes' : 'NO'}`);
if (login.status !== 200) { console.log(login.text); process.exit(1); }

// 2. session check
const sess = await call('/api/admin/session');
console.log(`[2] session        ${sess.status} user=${sess.json?.username}`);

// 3. create key
const key = await call('/api/admin/keys', {
  method: 'POST',
  body: JSON.stringify({ name: 'e2e-test', rpm: 30, rpd: 500 }),
});
console.log(`[3] create key     ${key.status} key=${key.json?.key?.slice(0, 14)}…`);
const API_KEY = key.json?.key;

// 4. tokens status
const tokens = await call('/api/admin/tokens');
console.log(`[4] pool           ${tokens.status} tokens=${tokens.json?.tokens?.length} status=${tokens.json?.tokens?.map((t) => t.status).join(',')}`);

// 5. models
const models = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
console.log(`[5] /v1/models     ${models.status} count=${(await models.json()).data?.length}`);

// 6. non-stream completion
const t0 = Date.now();
const comp = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are terse. Reply with a single short sentence.' },
      { role: 'user', content: 'Say "ShadowGate is alive" and nothing else.' },
    ],
  }),
});
const compJson = await comp.json().catch(() => null);
console.log(`[6] completion     ${comp.status} in ${Date.now() - t0}ms`);
console.log(`    content: ${JSON.stringify(compJson?.choices?.[0]?.message?.content ?? compJson?.error?.message ?? compJson)}`);

// 7. stream completion
const t1 = Date.now();
const stream = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [{ role: 'user', content: 'Count from 1 to 5, digits only, space separated.' }],
  }),
});
console.log(`[7] stream         ${stream.status} ct=${stream.headers.get('content-type')}`);
if (stream.status === 200) {
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chunks = 0;
  let out = '';
  let done = false;
  while (!done) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') { done = true; break; }
      try {
        const j = JSON.parse(data);
        const d2 = j.choices?.[0]?.delta?.content;
        if (d2) { out += d2; chunks++; }
      } catch { /* skip */ }
    }
  }
  console.log(`    streamed ${chunks} chunks in ${Date.now() - t1}ms: "${out}"`);
} else {
  console.log('    ', (await stream.text()).slice(0, 200));
}

// 8. bad key
const bad = await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer sg-nope' } });
console.log(`[8] bad key        ${bad.status} (expect 401)`);

console.log('\nE2E DONE');
