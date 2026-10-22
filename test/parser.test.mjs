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

test('served lane: server_ste_metadata tells chat from work mode', async () => {
  const served = async (name) => {
    const { body, inputIds } = fixtureStream(name);
    const all = {};
    for await (const ev of parseChatGPTSSE(body, inputIds)) if (ev.served) Object.assign(all, ev.served);
    return all;
  };
  const plain = await served('plain-reply');
  assert.equal(plain.experience, 'chat');
  assert.equal(plain.harness, 'Harmony');
  assert.equal(plain.slug, 'gpt-5-6');
  const wm = await served('thinking-reply');
  assert.equal(wm.experience, 'work');
  assert.equal(wm.harness, 'Harmony');
  assert.equal(wm.slug, 'gpt-6-astra-wm');
  assert.equal(wm.effort, 'extended', 'the thinking effort the backend reports it used');
});

test('tool call reply: the protocol block survives the parser verbatim', async () => {
  const { body, inputIds } = fixtureStream('tool-call');
  const r = await collect(parseChatGPTSSE(body, inputIds));
  assert.match(r.text, /<tool_call>[\s\S]*run_command[\s\S]*<\/tool_call>/);
});

test('stream handoff: the parser hands over the resume token and stops instead of reporting an empty turn', async () => {
  // what chatgpt.com sends for a long (xhigh / max / ultra) work-mode turn — captured 2026-10-22
  const frames = [
    { type: 'resume_conversation_token', kind: 'topic', token: 'tok-123', conversation_id: 'conv-1' },
    { type: 'stream_handoff', conversation_id: 'conv-1', turn_exchange_id: 'x', options: [{ type: 'resume_sse_endpoint', topic_id: 't' }, { type: 'subscribe_ws_topic', topic_id: 't' }] },
  ];
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  const events = [];
  for await (const ev of parseChatGPTSSE(body, new Set())) events.push(ev);
  assert.deepEqual(events, [{ handoff: { conversationId: 'conv-1', token: 'tok-123', topicId: 't' } }]);
});

test('stream handoff: a resumed stream replays the handoff frames, then the answer, which is read through', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fixtures } = await import('./helpers.mjs');
  const head = [
    { type: 'resume_conversation_token', kind: 'topic', token: 'tok-123', conversation_id: 'conv-1' },
    { type: 'stream_handoff', conversation_id: 'conv-1', options: [{ type: 'resume_sse_endpoint', topic_id: 't' }] },
  ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  const meta = JSON.parse(fs.readFileSync(path.join(fixtures, 'plain-reply.json'), 'utf8'));
  const raw = head + fs.readFileSync(path.join(fixtures, 'plain-reply.sse'), 'utf8');
  const stream = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(raw)); c.close(); } });
  const resumed = await collect(parseChatGPTSSE(stream(), new Set(meta.inputIds), { resumed: true }));
  assert.match(resumed.text, /quick brown fox jumps over the lazy dog/);
  // read as an original stream, the same frames stop at the handoff
  const original = [];
  for await (const ev of parseChatGPTSSE(stream(), new Set(meta.inputIds))) original.push(ev);
  assert.deepEqual(original, [{ handoff: { conversationId: 'conv-1', token: 'tok-123' } }]);
});

test('stream handoff: a resumed stream ends at message_stream_complete even if the connection stays open', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fixtures } = await import('./helpers.mjs');
  const meta = JSON.parse(fs.readFileSync(path.join(fixtures, 'plain-reply.json'), 'utf8'));
  // the plain reply without its trailing [DONE], then message_stream_complete, then the connection never closes
  const reply = fs.readFileSync(path.join(fixtures, 'plain-reply.sse'), 'utf8').replace(/data: \[DONE\][\s\S]*$/, '');
  const text = reply + `data: ${JSON.stringify({ type: 'message_stream_complete', conversation_id: 'conv-1' })}\n\n`;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); /* never closed */ } });
  const r = await collect(parseChatGPTSSE(body, new Set(meta.inputIds), { resumed: true }));
  assert.match(r.text, /quick brown fox jumps over the lazy dog/);
  assert.equal(r.finish, 'stop');
});
