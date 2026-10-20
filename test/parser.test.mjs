import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatGPTSSE } from '../dist/chatgpt/client.js';
import { fixtureStream, collect } from './helpers.mjs';

test('plain reply: full text, finish stop, slug echoed', async () => {
  const { body, inputIds } = fixtureStream('plain-reply');
  const r = await collect(parseChatGPTSSE(body, inputIds));
  assert.match(r.text, /quick brown fox jumps over the lazy dog/);
  assert.equal(r.finish, 'stop');
  assert.equal(r.slug, 'gpt-5-6');
  assert.ok(r.kinds.includes('text'));
});

test('plain reply: identical output regardless of chunk boundaries', async () => {
  const a = await collect(parseChatGPTSSE(fixtureStream('plain-reply', 13).body, fixtureStream('plain-reply').inputIds));
  const b = await collect(parseChatGPTSSE(fixtureStream('plain-reply', 50_000).body, fixtureStream('plain-reply').inputIds));
  assert.equal(a.text, b.text);
});

test('history echo: our own messages are never replayed as output', async () => {
  const { body, inputIds, meta } = fixtureStream('history-echo');
  const r = await collect(parseChatGPTSSE(body, inputIds));
  assert.match(r.text, /pelican/i);
  for (const m of meta.messages) if (m.role !== 'user' || !/name\?/.test(m.text)) assert.ok(!r.text.includes(m.text), `echoed: ${m.text}`);
  assert.ok(!r.text.includes('Hello Pelican.'));
});

test('thinking reply: reasoning summaries arrive separately from the answer', async () => {
  const { body, inputIds } = fixtureStream('thinking-reply');
  const r = await collect(parseChatGPTSSE(body, inputIds));
  assert.match(r.text, /121932631112635269/);
  assert.ok(r.reasoning.length > 0, 'expected thought summaries or a recap');
  assert.ok(!r.text.includes(r.reasoning.slice(0, 40)), 'reasoning must not leak into the visible text');
  assert.equal(r.slug, 'gpt-6-astra-wm');
});

test('tool call reply: the protocol block survives the parser verbatim', async () => {
  const { body, inputIds } = fixtureStream('tool-call');
  const r = await collect(parseChatGPTSSE(body, inputIds));
  assert.match(r.text, /<tool_call>[\s\S]*run_command[\s\S]*<\/tool_call>/);
});
