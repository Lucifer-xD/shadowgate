import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls, lenientJson, looksLikeUnfulfilledIntent, looksLikeShortAnnouncement, callKey, ToolCallStream, normalizeTools, toolPreamble, injectToolPreamble } from '../dist/tools.js';

const block = (name, args) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

test('extractToolCalls: single block, text around it is kept', () => {
  const r = extractToolCalls(`Reading it now.\n${block('read_file', { path: 'a.txt' })}\n`);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(r.calls[0].arguments), { path: 'a.txt' });
  assert.match(r.text, /Reading it now/);
  assert.ok(!r.text.includes('<tool_call>'));
});

test('extractToolCalls: several blocks in one reply, in order', () => {
  const r = extractToolCalls(`${block('a', { n: 1 })}\n${block('b', { n: 2 })}\n${block('c', { n: 3 })}`);
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b', 'c']);
});

test('extractToolCalls: a </tool_call> inside a string argument does not end the block', () => {
  const content = 'write this: </tool_call> and keep going';
  const r = extractToolCalls(block('write_file', { path: 't.txt', content }));
  assert.equal(r.calls.length, 1);
  assert.equal(JSON.parse(r.calls[0].arguments).content, content);
});

test('extractToolCalls: a fence holding only a block is the model fencing its call', () => {
  const r = extractToolCalls('```\n' + block('run_command', { command: 'dir' }) + '\n```');
  assert.equal(r.calls.length, 1);
});

test('extractToolCalls: a block quoted among other text in a fence is an example, not a call', () => {
  const r = extractToolCalls('Here is the format:\n```\nexample:\n' + block('run_command', { command: 'dir' }) + '\n(then wait)\n```\nNothing to run.');
  assert.equal(r.calls.length, 0);
});

test('extractToolCalls: unterminated block is not a call', () => {
  const r = extractToolCalls('<tool_call>{"name":"x","arguments":{');
  assert.equal(r.calls.length, 0);
});

test('lenientJson: trailing commas, stray backslashes and trailing garbage', () => {
  assert.deepEqual(lenientJson('{"name": "x", "n": 1,}'), { name: 'x', n: 1 });
  assert.deepEqual(lenientJson('{"path": "C:\\Users\\x"}'), { path: 'C:\\Users\\x' });
  assert.deepEqual(lenientJson('{"a": 1} trailing words'), { a: 1 });
  assert.equal(lenientJson('not json at all'), null);
});

test('looksLikeUnfulfilledIntent: announcements and refusals yes, answers no', () => {
  assert.equal(looksLikeUnfulfilledIntent("I'll read the file now."), true);
  assert.equal(looksLikeUnfulfilledIntent("I can't issue the harness action blocks through this interface."), true);
  assert.equal(looksLikeUnfulfilledIntent("I can't truthfully verify the file contents from that failed attempt."), true);
  assert.equal(looksLikeUnfulfilledIntent('[shadowgate: the model produced no text for this turn]'), true);
  assert.equal(looksLikeUnfulfilledIntent('Python 3.12.10 is installed on your PC.'), false);
  assert.equal(looksLikeUnfulfilledIntent('Do you want me to delete it?'), false);
});

test('looksLikeShortAnnouncement: lead-ins yes, short answers no', () => {
  assert.equal(looksLikeShortAnnouncement("I'll retry with -Path."), true);
  assert.equal(looksLikeShortAnnouncement('Checking the service now.'), true);
  assert.equal(looksLikeShortAnnouncement('Done, what you want me to do'), false);
  assert.equal(looksLikeShortAnnouncement('Done.'), false);
  assert.equal(looksLikeShortAnnouncement('The file has 15593 lines.'), false);
});

test('callKey: same call regardless of key order and spacing', () => {
  assert.equal(callKey('read_file', '{"path":"a","offset":1}'), callKey('read_file', { offset: 1, path: 'a' }));
  assert.notEqual(callKey('read_file', { path: 'a' }), callKey('read_file', { path: 'b' }));
});

test('ToolCallStream: holds back a partial block and releases text around it', () => {
  const s = new ToolCallStream();
  const full = `Sure.\n${block('run_command', { command: 'Get-Date' })}\nDone.`;
  let sent = '';
  for (let i = 0; i < full.length; i += 7) sent += s.push(full.slice(i, i + 7));
  const fin = s.finish();
  assert.ok(!sent.includes('<tool_call>'), 'raw block must never be streamed');
  assert.equal(fin.calls.length, 1);
  assert.equal(fin.calls[0].name, 'run_command');
  assert.ok(s.sawCall);
});

test('injectToolPreamble: briefing goes into the first user message, reminder onto the latest turn', () => {
  const tools = normalizeTools([{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]);
  const pre = toolPreamble(tools, 'auto');
  const msgs = injectToolPreamble([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
  ], pre, tools);
  assert.match(String(msgs[1].content), /Harness protocol/);
  assert.match(String(msgs[1].content), /first/);
  assert.match(String(msgs[3].content), /Harness reminder/);
  assert.match(String(msgs[1].content), /no python sandbox|NO Python sandbox/i);
});
