import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { mountMcp } from '../dist/mcp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const text = async (c, name, args = {}) => (await c.callTool({ name, arguments: args })).content.map((x) => x.text).join('\n');

async function harness() {
  // downstream connector with one read-only tool
  const down = new McpServer({ name: 'fake', version: '1' });
  down.registerTool('system_info', { description: 'machine name', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'computer name: TEST-BOX' }] }));
  const downApp = express(); downApp.use(express.json());
  downApp.all('/mcp', async (req, res) => {
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => t.close()); await down.connect(t); await t.handleRequest(req, res, req.body);
  });
  const downSrv = await listen(downApp);
  const downUrl = `http://127.0.0.1:${downSrv.address().port}/mcp`;

  // fake /v1
  const v1 = express(); v1.use(express.json());
  v1.get('/v1/models', (_q, r) => r.json({ object: 'list', default_model: 'gpt-6', data: [{ id: 'gpt-6', title: 'GPT-6', lane: 'chat', reasoning_efforts: ['low'] }] }));
  v1.get('/v1/usage', (_q, r) => r.type('text/plain').send('weekly 31% used.'));
  v1.post('/v1/chat/completions', (q, r) => {
    const hasTools = Array.isArray(q.body.tools) && q.body.tools.length;
    const last = q.body.messages.at(-1);
    if (hasTools && last.role !== 'tool') r.json({ model: 'gpt-5-6', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'system_info', arguments: '{}' } }] } }] });
    else if (hasTools) r.json({ model: 'gpt-5-6', choices: [{ message: { role: 'assistant', content: 'Done: TEST-BOX.' } }] });
    else r.json({ model: q.body.model, choices: [{ message: { role: 'assistant', content: `Echo: ${last.content}` } }], usage: { total_tokens: 12 } });
  });
  const v1Srv = await listen(v1);

  const KEY = 'sg-' + 'a'.repeat(48);
  process.env.SHADOWGATE_AGENT_CONNECTORS = JSON.stringify([{ name: 'PC Commander', url: downUrl }]);
  const store = { keys: [{ hash: sha(KEY), enabled: true, prefix: 'sg-aaaaaaa' }] };
  const app = express(); app.use(express.json());
  mountMcp(app, store, { version: 'test', port: v1Srv.address().port });
  const mcpSrv = await listen(app);
  const port = mcpSrv.address().port;
  return { KEY, port, close: () => { downSrv.close(); v1Srv.close(); mcpSrv.close(); } };
}

const client = (port, key) => { const c = new Client({ name: 't', version: '1' }); return c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?key=${key}`))).then(() => c); };

test('mcp: a wrong key is refused with 401', async () => {
  const h = await harness();
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/mcp?key=sg-wrong`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) });
    assert.equal(r.status, 401);
  } finally { h.close(); }
});

test('mcp: exposes the four tools and ask_model shows what was sent and the reply', async () => {
  const h = await harness();
  try {
    const c = await client(h.port, h.KEY);
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['ask_model', 'list_models', 'run_task', 'usage']);
    assert.match(await text(c, 'list_models'), /gpt-6 — GPT-6/);
    const a = await text(c, 'ask_model', { model: 'gpt-6', prompt: 'hello there' });
    assert.match(a, /requested "gpt-6"/);
    assert.match(a, /Prompt: hello there/);
    assert.match(a, /Echo: hello there/);
    assert.match(await text(c, 'usage'), /weekly 31% used/);
    await c.close();
  } finally { h.close(); }
});

test('mcp: run_task drives the downstream connector and reports the steps', async () => {
  const h = await harness();
  try {
    const c = await client(h.port, h.KEY);
    const out = await text(c, 'run_task', { task: 'tell me the machine name' });
    assert.match(out, /Task on "PC Commander"/);
    assert.match(out, /1\. system_info\(\{\}\) → computer name: TEST-BOX/);
    assert.match(out, /Result:\nDone: TEST-BOX\./);
    await c.close();
  } finally { h.close(); }
});
