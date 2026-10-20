import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, textSize } from '../dist/gateway.js';

const big = (n, ch) => ch.repeat(n);

function history(chunks = 20, size = 40_000) {
  const msgs = [
    { role: 'system', content: 'SYSTEM ' + big(3000, 's') },
    { role: 'user', content: 'FIRST USER: read the script' },
    { role: 'assistant', content: 'ok' },
  ];
  for (let i = 0; i < chunks; i++) {
    msgs.push({ role: 'assistant', content: `<tool_call>{"name":"read_file","arguments":{"offset":${i}}}</tool_call>` });
    msgs.push({ role: 'tool', content: `CHUNK ${i} ` + big(size, String(i % 10)) });
  }
  msgs.push({ role: 'assistant', content: 'done reading' });
  msgs.push({ role: 'user', content: 'LATEST: what does it do?' });
  return msgs;
}

test('compactHistory: brings an oversized tool history under budget', () => {
  const msgs = history();
  const before = textSize(msgs);
  const out = compactHistory(msgs, 480_000);
  assert.ok(before > 480_000);
  assert.ok(textSize(out) <= 480_000);
});

test('compactHistory: system prompt, first user message and latest exchange survive intact', () => {
  const msgs = history();
  const out = compactHistory(msgs, 480_000);
  assert.equal(out[0].content, msgs[0].content);
  assert.equal(out[1].content, 'FIRST USER: read the script');
  assert.equal(out.at(-1).content, 'LATEST: what does it do?');
  assert.equal(out.at(-2).content, 'done reading');
});

test('compactHistory: clipped tool results carry a marker and keep head and tail', () => {
  const out = compactHistory(history(), 480_000);
  const clipped = out.filter((m) => typeof m.content === 'string' && m.content.includes('truncated by the gateway'));
  assert.ok(clipped.length > 0);
  assert.match(clipped[0].content, /^CHUNK \d+ /);
});

test('compactHistory: image parts are kept when a message is clipped', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: big(300_000, 'a') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: big(300_000, 'b') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
  ];
  const out = compactHistory(msgs, 480_000);
  assert.ok(textSize(out) <= 480_000);
  for (const m of out) if (Array.isArray(m.content)) assert.ok(m.content.some((p) => p.type === 'image_url'), 'image part dropped');
});

test('textSize: image bytes do not count', () => {
  const withImage = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + big(1_000_000, 'A') } }] }];
  assert.ok(textSize(withImage) < 1000);
});

test('compactHistory: a lone oversize message is clipped, not rejected', () => {
  const out = compactHistory([{ role: 'user', content: big(700_000, 'q') }], 480_000);
  assert.ok(textSize(out) <= 480_000);
  assert.match(out[0].content, /truncated by the gateway/);
});
