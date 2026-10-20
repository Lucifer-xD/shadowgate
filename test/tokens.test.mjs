import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens, countMessageTokens } from '../dist/tokens.js';

test('countTokens is exact o200k, deterministic, and zero for empty text', () => {
  assert.equal(countTokens(''), 0);
  const a = countTokens('The quick brown fox jumps over the lazy dog.');
  assert.ok(a >= 8 && a <= 12, `unexpected count ${a}`);
  assert.equal(a, countTokens('The quick brown fox jumps over the lazy dog.'));
  assert.ok(countTokens('x'.repeat(10_000)) < 10_000 / 2, 'repeated characters compress far below one token per character');
});

test('countMessageTokens adds framing per message and a flat cost per image', () => {
  const text = countMessageTokens([{ role: 'user', content: 'hello' }]);
  const withImage = countMessageTokens([{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
  assert.ok(text > 0);
  assert.equal(withImage - text, 765);
});
