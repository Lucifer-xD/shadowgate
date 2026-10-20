import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initContinuationStore, rememberContinuation, findContinuation, saveNow, _resetContinuation } from '../dist/continuation.js';

test('the continuation cache round-trips through its file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cont-'));
  const file = path.join(dir, 'continuation.json');
  _resetContinuation();
  initContinuationStore(file);
  const history = [{ role: 'user', content: 'hello' }];
  rememberContinuation(history, 'm', 'high', { conversationId: 'c1', parentId: 'p1', tokenId: 't1', model: 'slug', persisted: false });
  saveNow();
  assert.ok(fs.existsSync(file));
  _resetContinuation();
  assert.equal(findContinuation([...history, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'again' }], 'm', 'high'), null);
  initContinuationStore(file);
  const hit = findContinuation([...history, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'again' }], 'm', 'high');
  assert.ok(hit);
  assert.equal(hit.entry.conversationId, 'c1');
  _resetContinuation();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('expired entries are not restored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cont-'));
  const file = path.join(dir, 'continuation.json');
  fs.writeFileSync(file, JSON.stringify({ entries: [['k', { conversationId: 'old', parentId: 'p', tokenId: 't', model: 'm', persisted: false, createdAt: 1, lastUsed: 1, turns: 1 }]] }));
  _resetContinuation();
  initContinuationStore(file);
  assert.equal(findContinuation([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }], 'm', undefined), null);
  _resetContinuation();
  fs.rmSync(dir, { recursive: true, force: true });
});
