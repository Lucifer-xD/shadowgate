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

test('both lanes are listed: bare GPT-6 slugs (chat lane) and -wm work-mode slugs', () => {
  const cat = catalog();
  const bare = cat.models.find((m) => m.slug === 'gpt-6-astra');
  const wm = cat.models.find((m) => m.slug === 'gpt-6-astra-wm');
  assert.ok(bare && bare.direct && !bare.workMode);
  assert.ok(wm && wm.workMode);
  assert.match(wm.title, /work mode/);
  const r = resolveModel('gpt-6-astra', 'high', cat);
  assert.equal(r.slug, 'gpt-6-astra');
  assert.equal(r.workMode, undefined);
  assert.equal(r.effort, 'extended');
  const w = resolveModel('gpt-6-astra-wm', 'high', cat);
  assert.equal(w.slug, 'gpt-6-astra-wm');
  assert.equal(w.workMode, true);
  assert.ok(cat.models.some((m) => m.slug === 'gpt-6' && m.direct));
});

test('codename and bare-generation aliases', () => {
  const cat = catalog();
  assert.equal(resolveModel('astra', undefined, cat).slug, 'gpt-6-astra');
  assert.equal(resolveModel('sol', undefined, cat).slug, 'gpt-6.1-sol');
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
