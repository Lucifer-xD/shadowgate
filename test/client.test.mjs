import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, withCleanWorkModels, uniqueTitles, effortTable, mapEffort, buildConversationBody, cleanVisibleText } from '../dist/chatgpt/client.js';
import { sniffMime, imageSize } from '../dist/chatgpt/images.js';

const catalog = () => withCleanWorkModels({
  defaultModel: 'gpt-5-6',
  models: [
    { slug: 'gpt-5-6', title: 'GPT-5.6 Sol', reasoning: 'auto', efforts: [], maxTokens: 137000 },
    { slug: 'gpt-5-6-instant', title: 'GPT-5.6 Sol', reasoning: 'instant', efforts: [], maxTokens: 137000 },
    { slug: 'gpt-5-6-thinking', title: 'GPT-5.6 Sol', reasoning: 'reasoning', efforts: ['standard', 'extended'], maxTokens: 262144 },
    { slug: 'gpt-5-6-pro', title: 'GPT-5.6 Pro', reasoning: 'pro', efforts: ['standard'], maxTokens: 410000 },
    { slug: 'gpt-5-6-mini', title: 'GPT-5.6 Luna', reasoning: 'none', efforts: [], maxTokens: 137000 },
    { slug: 'gpt-6-astra-wm', title: 'GPT-6 Astra', reasoning: 'reasoning', efforts: ['standard', 'extended'], maxTokens: 262144, workMode: true },
    { slug: 'gpt-6.1-sol-wm', title: 'GPT-6.1 Sol', reasoning: 'reasoning', efforts: ['standard', 'extended'], maxTokens: 262144, workMode: true },
    { slug: 'gpt-5.6-terra-wm', title: 'GPT-5.6 Terra', reasoning: 'reasoning', efforts: ['standard', 'extended'], maxTokens: 262144, workMode: true },
  ],
});

test('one honest chat-lane row; every GPT-6 name without -wm goes to it; -wm rows are the real family', () => {
  const cat = catalog();
  const lane = cat.models.find((m) => m.slug === 'gpt-6');
  assert.ok(lane && lane.direct && !lane.workMode);
  assert.match(lane.title, /chat lane/);
  assert.ok(!cat.models.some((m) => m.slug === 'gpt-6-astra'), 'no bare Astra row');
  for (const name of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'astra', 'sol', 'luna', 'gpt-6']) {
    const r = resolveModel(name, 'high', cat);
    assert.equal(r.slug, 'gpt-6', name);
    assert.equal(r.workMode, undefined, name);
  }
  const w = resolveModel('gpt-6-astra-wm', 'high', cat);
  assert.equal(w.slug, 'gpt-6-astra-wm');
  assert.equal(w.workMode, true);
  assert.equal(w.effort, 'extended');
  assert.match(cat.models.find((m) => m.slug === 'gpt-6-astra-wm').title, /work mode/);
});

test('codename and bare-generation aliases', () => {
  const cat = catalog();
  assert.equal(resolveModel('astra', undefined, cat).slug, 'gpt-6');
  assert.equal(resolveModel('sol', undefined, cat).slug, 'gpt-6');
  assert.equal(resolveModel('terra', undefined, cat).slug, 'gpt-5.6-terra-wm');
  assert.equal(resolveModel('gpt-6', undefined, cat).slug, 'gpt-6');
});

test('lane aliases stay on the listed plain models', () => {
  const cat = catalog();
  assert.equal(resolveModel('o3', undefined, cat).slug, 'gpt-5-6-thinking');
  assert.equal(resolveModel('gpt-5-thinking', undefined, cat).slug, 'gpt-5-6-thinking');
  assert.equal(resolveModel('gpt-4o-mini', undefined, cat).slug, 'gpt-5-6-mini');
  assert.equal(resolveModel('gpt-5-pro', undefined, cat).slug, 'gpt-5-6-pro');
  assert.equal(resolveModel('auto', undefined, cat).slug, 'gpt-5-6');
  assert.equal(resolveModel('made-up-name', undefined, cat).slug, 'gpt-5-6');
});

test('a high effort on a plain alias upgrades to the thinking lane', () => {
  assert.equal(resolveModel('gpt-5', 'high', catalog()).slug, 'gpt-5-6-thinking');
});

test('titles are unique per listed model; hidden -wm rows keep theirs', () => {
  const cat = uniqueTitles(catalog());
  const titles = cat.models.filter((m) => !/-wm$/.test(m.slug)).map((m) => m.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.ok(titles.includes('GPT-5.6 Sol Instant'));
  assert.ok(titles.includes('GPT-5.6 Sol Thinking'));
});

test('effort mapping: OpenAI levels collapse onto standard/extended; Pro offers nothing', () => {
  assert.deepEqual(effortTable(['standard', 'extended']), { none: 'standard', minimal: 'standard', low: 'standard', medium: 'standard', high: 'extended', xhigh: 'extended' });
  assert.deepEqual(effortTable(['standard']), {});
  assert.equal(mapEffort('xhigh', ['standard', 'extended']), 'extended');
  assert.equal(mapEffort('max', ['standard', 'extended']), 'extended');
  assert.equal(mapEffort('low', ['standard', 'extended']), 'standard');
  assert.equal(mapEffort('high', []), undefined);
});

test('buildConversationBody: work mode adds conversation_origin, system prompt rides as critic', () => {
  const body = buildConversationBody([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], 'gpt-6-astra-wm', 'extended', true);
  assert.equal(body.conversation_origin, 'tpp');
  assert.equal(body.thinking_effort, 'extended');
  assert.equal(body.messages[0].author.role, 'critic');
  assert.equal(body.messages[1].content.parts[0], 'hi');
  const plain = buildConversationBody([{ role: 'user', content: 'hi' }], 'gpt-5-6');
  assert.equal(plain.conversation_origin, undefined);
});

test('cleanVisibleText strips private-use markers and writing fences', () => {
  assert.equal(cleanVisibleText('aciteb :::writing{x}\nc'), 'ab c');
});

test('image sniffing and sizes', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000d49484452', 'hex'), Buffer.from('00000280', 'hex'), Buffer.from('000001e0', 'hex')]);
  assert.equal(sniffMime(png), 'image/png');
  assert.deepEqual(imageSize(png, 'image/png'), { width: 640, height: 480 });
  assert.equal(sniffMime(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffMime(Buffer.from('hello')), null);
});

test('every work-mode model has a metered Codex-lane twin reachable only by its exact name', () => {
  const cat = catalog();
  const twin = cat.models.find((m) => m.slug === 'gpt-6-astra-codex');
  assert.ok(twin, 'gpt-6-astra-codex listed');
  assert.equal(twin.saved, true);
  assert.equal(twin.workMode, true);
  assert.equal(twin.upstreamSlug, 'gpt-6-astra-wm');
  assert.match(twin.title, /^GPT-6 Astra · Codex \(metered\)$/);
  assert.ok(cat.models.some((m) => m.slug === 'gpt-6.1-sol-codex' && m.saved));
  assert.ok(cat.models.some((m) => m.slug === 'gpt-5.6-terra-codex' && m.saved));
  assert.ok(!cat.models.some((m) => m.slug === 'gpt-6-codex'), 'the chat lane has no twin');

  const saved = resolveModel('gpt-6-astra-codex', 'high', cat);
  assert.equal(saved.slug, 'gpt-6-astra-wm');
  assert.equal(saved.workMode, true);
  assert.equal(saved.saved, true);
  assert.equal(saved.effort, 'extended');

  const temp = resolveModel('gpt-6-astra-wm', 'high', cat);
  assert.equal(temp.slug, 'gpt-6-astra-wm');
  assert.equal(temp.saved, undefined);
  // aliases stay on the free lanes
  assert.equal(resolveModel('terra', undefined, cat).saved, undefined);
  assert.equal(resolveModel('terra', undefined, cat).slug, 'gpt-5.6-terra-wm');
  assert.equal(resolveModel('astra', undefined, cat).saved, undefined);
});
