import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findContinuation, rememberContinuation, forgetConversation, sweepExpired, historyKey, continuesInPlace, _resetContinuation } from '../dist/continuation.js';

const base = () => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'first question' },
];
const entry = (over = {}) => ({ conversationId: 'conv-1', parentId: 'msg-a1', tokenId: 'tok-1', model: 'gpt-6-astra-wm', persisted: true, ...over });

beforeEach(() => _resetContinuation());

test('a request that is the previous one plus assistant + user continues', () => {
  rememberContinuation(base(), 'gpt-6-astra', 'high', entry());
  const next = [...base(), { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'second question' }];
  const hit = findContinuation(next, 'gpt-6-astra', 'high');
  assert.ok(hit);
  assert.equal(hit.entry.conversationId, 'conv-1');
  assert.equal(hit.entry.parentId, 'msg-a1');
  assert.deepEqual(hit.newMessages.map((m) => m.content), ['second question']);
});

test('several new tool results in one request are all sent', () => {
  rememberContinuation(base(), 'm', undefined, entry());
  const next = [...base(), { role: 'assistant', content: 'calls' }, { role: 'tool', content: 'r1' }, { role: 'tool', content: 'r2' }, { role: 'user', content: 'go on' }];
  const hit = findContinuation(next, 'm', undefined);
  assert.ok(hit);
  assert.equal(hit.newMessages.length, 3);
});

test('a different model, effort or edited history misses', () => {
  rememberContinuation(base(), 'm', 'high', entry());
  const next = [...base(), { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }];
  assert.equal(findContinuation(next, 'other-model', 'high'), null);
  assert.equal(findContinuation(next, 'm', 'low'), null);
  const edited = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first question (edited)' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }];
  assert.equal(findContinuation(edited, 'm', 'high'), null);
  // no assistant turn between the known prefix and the new message → not a continuation
  assert.equal(findContinuation([...base(), { role: 'user', content: 'b' }], 'm', 'high'), null);
});

test('the harness reminder moving between turns does not change the key', () => {
  const reminder = '\n\n[Harness reminder: you act on the user machine ONLY by replying with <tool_call> blocks.]';
  const withReminder = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first question' + reminder }];
  rememberContinuation(withReminder, 'm', undefined, entry());
  const next = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first question' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' + reminder }];
  assert.ok(findContinuation(next, 'm', undefined));
});

test('the gateway output-format note is ignored by the key too', () => {
  const note = '\n\n[Output format: respond with a single valid JSON object and nothing else.]';
  rememberContinuation([{ role: 'user', content: 'q1' + note }], 'm', undefined, entry());
  assert.ok(findContinuation([{ role: 'user', content: 'q1' }, { role: 'assistant', content: '{}' }, { role: 'user', content: 'q2' + note }], 'm', undefined));
});

test('image parts take part in the key by content', () => {
  const img = (data) => [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }];
  rememberContinuation([{ role: 'user', content: img('AAAA') }], 'm', undefined, entry());
  assert.ok(findContinuation([{ role: 'user', content: img('AAAA') }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }], 'm', undefined));
  assert.equal(findContinuation([{ role: 'user', content: img('BBBB') }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }], 'm', undefined), null);
});

test('forgetConversation and sweepExpired', () => {
  rememberContinuation(base(), 'm', undefined, entry());
  forgetConversation('conv-1');
  assert.equal(findContinuation([...base(), { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }], 'm', undefined), null);
  rememberContinuation(base(), 'm', undefined, entry({ conversationId: 'conv-2' }));
  assert.deepEqual(sweepExpired(Date.now() + 60 * 60_000).map((e) => e.conversationId), ['conv-2']);
  assert.equal(findContinuation([...base(), { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }], 'm', undefined), null);
});

test('historyKey is stable and order-sensitive', () => {
  assert.equal(historyKey(base(), 'm', 'x'), historyKey(base(), 'm', 'x'));
  assert.notEqual(historyKey(base(), 'm', 'x'), historyKey([...base()].reverse(), 'm', 'x'));
});

test('continuesInPlace: temporary work-mode chats are resent whole, so their full history counts against the budget', () => {
  const entry = (model, persisted) => ({ conversationId: 'c', parentId: 'p', tokenId: 't', model, persisted, createdAt: 0, lastUsed: 0, turns: 1 });
  assert.equal(continuesInPlace(entry('gpt-5-6', false)), true);
  assert.equal(continuesInPlace(entry('gpt-6', false)), true);
  assert.equal(continuesInPlace(entry('gpt-6-astra-wm', false)), false);
  assert.equal(continuesInPlace(entry('gpt-6-astra-wm', true)), true);
});
