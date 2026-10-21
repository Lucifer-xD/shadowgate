import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../dist/chatgpt/client.js';
import { asksAboutUsage, accountUsage, humanDuration, usageNote, usageText } from '../dist/usage.js';
import { historyKey } from '../dist/continuation.js';

// shape recorded from GET https://chatgpt.com/backend-api/wham/usage (ids removed)
const NOW = 1792606000; // epoch seconds
const BODY = {
  plan_type: 'k12',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: NOW + 18000 },
    secondary_window: { used_percent: 31, limit_window_seconds: 604800, reset_after_seconds: 275414, reset_at: NOW + 275414 },
  },
  model_usage: { 'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false } },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0', approx_local_messages: [0, 0], approx_cloud_messages: [0, 0] },
};

test('parseUsage reads both windows, credits and per-model availability', () => {
  const u = parseUsage(BODY, new Date(NOW * 1000));
  assert.equal(u.plan, 'k12');
  assert.equal(u.allowed, true);
  assert.equal(u.limitReached, false);
  assert.deepEqual(u.primary, { usedPercent: 0, windowSeconds: 18000, resetAt: NOW + 18000 });
  assert.deepEqual(u.secondary, { usedPercent: 31, windowSeconds: 604800, resetAt: NOW + 275414 });
  assert.equal(u.credits.hasCredits, false);
  assert.equal(u.credits.balance, 0);
  assert.deepEqual(u.credits.approxLocalMessages, [0, 0]);
  assert.deepEqual(u.models, { 'gpt-6-astra': { available: true } });
});

test('parseUsage tolerates a missing or partial body', () => {
  const u = parseUsage({});
  assert.equal(u.allowed, true);
  assert.equal(u.primary, undefined);
  assert.equal(u.credits, undefined);
});

test('usage text names the windows, what is left and when each resets', () => {
  const t = { id: 't1', label: 'Main Account', status: 'healthy', plan: 'k12', usage: parseUsage(BODY, new Date(NOW * 1000)) };
  const a = accountUsage(t, NOW * 1000);
  assert.equal(a.weekly.remaining_percent, 69);
  assert.equal(a.weekly.resets_in_seconds, 275414);
  const text = usageText({ object: 'usage', generated_at: new Date(NOW * 1000).toISOString(), accounts: [a], key: { name: 'zadloop', requests_5h: 3, requests_24h: 10, requests_total: 99, rpm_limit: 60, rpd_limit: 1000, remaining_today: 990 }, note: 'n' });
  assert.match(text, /Main Account \(k12 plan\)/);
  assert.match(text, /5-hour limit 0% used, 100% left, resets in 5h 0m/);
  assert.match(text, /weekly limit 31% used, 69% left, resets in 3d 4h/);
  assert.match(text, /gpt-6-astra available/);
  assert.match(text, /This API key "zadloop": 3 requests in the last 5 hours, 10 in the last 24 hours/);
});

test('humanDuration', () => {
  assert.equal(humanDuration(275414), '3d 4h');
  assert.equal(humanDuration(18000), '5h 0m');
  assert.equal(humanDuration(30), '1m');
});

test('asksAboutUsage catches usage questions in English and Arabic', () => {
  for (const q of [
    "what's my usage?",
    'how much usage do I have left',
    'check my limits',
    'show me my weekly limit',
    'how much quota is left',
    'have I reached my limit yet?',
    'when does my limit reset',
    'what is the 5-hour limit status',
    'كم استخدامي النهارده؟',
    'عايز اعرف الليميت بتاعي',
    'tell me the remaining credits',
  ]) assert.equal(asksAboutUsage(q), true, q);
});

test('asksAboutUsage ignores coding talk about usage', () => {
  for (const q of [
    'add a usage example to the README',
    'check the usage of this function across the repo',
    'reduce memory usage in the parser',
    'what is the limit of this loop?',
    'show the usage text when --help is passed',
    'fix the bug in rate limiter tests',
  ]) assert.equal(asksAboutUsage(q), false, q);
});

test('the attached usage note never changes the continuation key', () => {
  const plain = [{ role: 'system', content: 's' }, { role: 'user', content: "what's my usage?" }];
  const noted = [plain[0], { role: 'user', content: plain[1].content + usageNote('ShadowGate live usage: …\n- Main: 5-hour [x] 0% used') }];
  assert.equal(historyKey(noted, 'gpt-6', undefined), historyKey(plain, 'gpt-6', undefined));
  const reminded = [plain[0], { role: 'user', content: plain[1].content + '\n\n[Harness reminder: tools]' + usageNote('data') }];
  assert.equal(historyKey(reminded, 'gpt-6', undefined), historyKey(plain, 'gpt-6', undefined));
});

test('GET /v1/usage returns the accounts plus the calling key (JSON and text)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const express = (await import('express')).default;
  const { Store } = await import('../dist/store.js');
  const { mountGateway } = await import('../dist/gateway.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-usage-'));
  const nowIso = new Date().toISOString();
  const secret = 'sg-usagetest-' + 'x'.repeat(30);
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({
    settings: { adminUser: 'a', adminHash: 'x', mustChangePw: false, sessionVersion: 1, totpSecret: null, ipSalt: 's', brandName: 'ShadowGate' },
    tokens: [{ id: 't1', label: 'Main Account', sessionHash: 'h', encSession: '', encAccess: '', deviceId: 'd', ua: 'u', email: 'dave@example.org', plan: 'k12', status: 'healthy', failCount: 0, createdAt: nowIso,
      usage: parseUsage({ ...BODY, rate_limit: { ...BODY.rate_limit, secondary_window: { ...BODY.rate_limit.secondary_window, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }) }],
    keys: [{ id: 'k1', name: 'opencode', hash: crypto.createHash('sha256').update(secret).digest('hex'), prefix: 'sg-usag', enabled: true, rpm: 60, rpd: 500, totalRequests: 7, totalChars: 0, createdAt: nowIso }],
    requests: [{ ts: nowIso, keyId: 'k1', model: 'gpt-6', stream: false, status: 200, latencyMs: 1, charsIn: 1, charsOut: 1 }],
    audit: [],
  }));
  const store = new Store(dir, () => { throw new Error('unexpected fresh settings'); });
  let refreshed = 0;
  const pool = { refreshAllUsage: async () => { refreshed++; return store.tokens; } };
  const app = express();
  app.use(express.json());
  mountGateway(app, store, { version: 'test' }, pool, null);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1/usage`;
    const auth = { authorization: `Bearer ${secret}` };
    assert.equal((await fetch(base)).status, 401);
    const j = await (await fetch(base, { headers: auth })).json();
    assert.equal(j.object, 'usage');
    assert.equal(j.accounts[0].email, 'd***@example.org');
    assert.equal(j.accounts[0].weekly.used_percent, 31);
    assert.equal(j.key.name, 'opencode');
    assert.equal(j.key.requests_24h, 1);
    assert.equal(j.key.remaining_today, 499);
    const t = await (await fetch(`${base}?format=text`, { headers: auth })).text();
    assert.match(t, /weekly limit 31% used, 69% left, resets in (59m|1h 0m)/);
    assert.ok(refreshed >= 2);
  } finally {
    server.close();
    store.flush?.();
  }
});
