// Generate dashboard traffic for screenshots: a burst of varied requests.
// Usage: node scripts/gen-traffic.mjs <api-key>
const BASE = process.env.BASE_URL || 'http://localhost:4315';
const KEY = process.argv[2];
if (!KEY) { console.error('usage: node scripts/gen-traffic.mjs sg-...'); process.exit(1); }

const prompts = [
  ['gpt-4o-mini', 'What is the capital of Japan? One word.'],
  ['auto', 'Name three shades of purple.'],
  ['gpt-4o', 'Explain entropy in one sentence.'],
  ['gpt-4o-mini', 'Write a haiku about gateways.'],
  ['auto', 'What does HTTP 429 mean? One sentence.'],
  ['gpt-4o-mini', 'Give me one async programming tip.'],
];

const fire = async (model, content) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: Math.random() > 0.5 }),
    });
    console.log(model, r.status, `${Date.now() - t0}ms`);
  } catch (e) { console.log(model, 'ERR', e.message); }
};

// one 401 for the error chart
await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: 'Bearer sg-invalid0000000000000000000000', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
});
console.log('bad-key 401');

await Promise.all(prompts.map(([m, p]) => fire(m, p)));
console.log('traffic done');
