import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionHistory } from '../dist/summarize.js';

const msgs = (n) => {
  const out = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first' }];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` });
  return out;
};

test('partitionHistory keeps the system prompt + first user message and the latest turns verbatim', () => {
  const p = partitionHistory(msgs(20), 6);
  assert.deepEqual(p.head.map((m) => m.content), ['sys', 'first']);
  assert.equal(p.tail.length, 6);
  assert.equal(p.middle.length, 20 - 6);
  assert.equal(p.tail.at(-1).content, 'm19');
});

test('partitionHistory with a short history has an empty middle', () => {
  const p = partitionHistory(msgs(3), 6);
  assert.equal(p.middle.length, 0);
  assert.equal(p.head.length + p.tail.length, 5);
});

test('a huge first user message is data, not the task statement: it goes to the middle', () => {
  const p = partitionHistory([{ role: 'system', content: 'sys' }, { role: 'user', content: 'x'.repeat(100_000) }, { role: 'assistant', content: 'ACK' }, { role: 'user', content: 'y'.repeat(100_000) }, { role: 'assistant', content: 'ACK' }, { role: 'user', content: 'keys?' }], 6, 50_000);
  assert.deepEqual(p.head.map((m) => m.content), ['sys']);
  assert.ok(p.middle.length >= 2, 'big chunks must be summarisable');
  assert.equal(p.tail.at(-1).content, 'keys?');
  const tailChars = p.tail.reduce((n, m) => n + m.content.length, 0);
  assert.ok(tailChars <= 50_000 + 'keys?'.length);
});

test('partitionHistory without a system prompt starts the head at the first user message', () => {
  const p = partitionHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], 1);
  assert.deepEqual(p.head.map((m) => m.content), ['a']);
  assert.deepEqual(p.middle.map((m) => m.content), ['b']);
  assert.deepEqual(p.tail.map((m) => m.content), ['c']);
});

test('segmentMiddle keeps messages whole and splits only between them', async () => {
  const { segmentMiddle } = await import('../dist/summarize.js');
  const middle = [{ role: 'user', content: 'a'.repeat(150_000) }, { role: 'assistant', content: 'ACK' }, { role: 'user', content: 'b'.repeat(150_000) }, { role: 'assistant', content: 'ACK' }];
  const segs = segmentMiddle(middle, 200_000);
  assert.equal(segs.length, 2);
  assert.ok(segs[0].includes('a'.repeat(150_000)));
  assert.ok(segs[1].includes('b'.repeat(150_000)));
});
