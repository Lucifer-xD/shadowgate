// MCP connector endpoint: lets an MCP client (e.g. ChatGPT custom connectors)
// reach ShadowGate's models.
//
//   POST /mcp?key=sg-...        (or Authorization: Bearer sg-...)
//
// Every tool runs through this gateway's own /v1 API over loopback with the
// caller's key, so model routing, continuation, per-key rate limits, request
// logging and the usage endpoint all behave exactly as for any other client.
//
// Tools:
//   list_models  - the models this key may use
//   ask_model    - ask one model once; the result shows what was sent and the reply
//   usage        - current account + key usage
//   run_task     - give a model a task it carries out by using a configured
//                  downstream connector's tools (e.g. PC Commander), returning a
//                  step-by-step transcript plus the final result
//
// Downstream connectors for run_task are configured server-side via the env var
// SHADOWGATE_AGENT_CONNECTORS, a JSON array of { "name": "...", "url": "https://.../mcp?key=..." }.
import { z } from 'zod';
import type { Express, Request as Req, Response as Res } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Store, ApiKeyRecord } from './store.js';
import type { Config } from './config.js';
import { sha256hex } from './util.js';

interface Connector { name: string; url: string }

const DEFAULT_AGENT_MODEL = 'gpt-5-6';
const MAX_STEPS = 12;
const TOOL_RESULT_CAP = 8000;

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const short = (v: unknown, n = 160): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function loadConnectors(): Connector[] {
  try {
    const raw = process.env.SHADOWGATE_AGENT_CONNECTORS;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => c && typeof c.name === 'string' && typeof c.url === 'string').map((c) => ({ name: c.name, url: c.url }));
  } catch {
    console.warn('[mcp] SHADOWGATE_AGENT_CONNECTORS is not valid JSON — no agent connectors loaded');
    return [];
  }
}

function keyFromReq(req: Req): string {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer || String(req.query.key || '').trim();
}

export function mountMcp(app: Express, store: Store, cfg: Config): void {
  const connectors = loadConnectors();
  const base = `http://127.0.0.1:${cfg.port}`;

  // one call to this gateway's own /v1, as the caller
  async function v1(path: string, key: string, init?: { method?: string; body?: string }): Promise<globalThis.Response> {
    return fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init?.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(300_000),
    });
  }

  // Metered models (the -codex rows: a work-mode model in a saved chat, which counts toward the
  // plan's 5-hour and weekly usage) are never reachable through this connector, so a client
  // such as ChatGPT can't spend the user's usage on its own. Set SHADOWGATE_MCP_ALLOW_METERED=1
  // to lift the block.
  const allowMetered = process.env.SHADOWGATE_MCP_ALLOW_METERED === '1';
  async function modelRows(key: string): Promise<{ rows: any[]; metered: Set<string>; defaultModel: string } | null> {
    const r = await v1('/v1/models', key);
    const j: any = await r.json().catch(() => null);
    if (!r.ok || !j) return null;
    const rows: any[] = j.data || [];
    const metered = new Set(rows.filter((m) => m.metered).map((m) => String(m.id).toLowerCase()));
    return { rows, metered, defaultModel: j.default_model || 'auto' };
  }
  const isMetered = (name: string, metered: Set<string>) => !allowMetered && (/codex/i.test(name) || metered.has(name.toLowerCase()));
  const blockedText = (name: string, rows: any[]) =>
    `"${name}" is a metered model: it counts toward your ChatGPT plan's 5-hour and weekly usage, so this connector does not use it. ` +
    `Pick a free model instead, for example: ${rows.filter((m) => !m.metered).slice(0, 8).map((m) => m.id).join(', ')}.`;

  function buildServer(key: string): McpServer {
    const server = new McpServer({ name: 'shadowgate', version: cfg.version }, {
      instructions:
        'ShadowGate exposes your own models. Use ask_model to ask one model a question (Astra, GPT-6, GPT-5.6 and others); ' +
        'the result shows exactly what was sent and the full reply. Use run_task to have a model carry out a task by operating ' +
        'a connected tool server such as PC Commander — it returns the steps it took and the outcome. list_models lists the models; usage shows limits.',
    });

    server.registerTool('list_models', {
      description: 'List the ShadowGate models this key may use, with their titles and which thinking efforts they accept.',
      inputSchema: {},
    }, async () => {
      const info = await modelRows(key);
      if (!info) return textResult('Could not list models.');
      const visible = info.rows.filter((m) => !isMetered(String(m.id), info.metered));
      const lines = visible.map((m: any) => `${m.id}${m.title && m.title !== m.id ? ` — ${m.title}` : ''}${m.lane ? ` [${m.lane}]` : ''}${Array.isArray(m.reasoning_efforts) && m.reasoning_efforts.length ? ` · efforts: ${m.reasoning_efforts.join('/')}` : ''}`);
      const hidden = info.rows.length - visible.length;
      return textResult(`${lines.length} models (default ${info.defaultModel}):\n${lines.join('\n')}${hidden ? `\n\n${hidden} metered models (the -codex rows, which count toward your plan's usage) are hidden from this connector.` : ''}`);
    });

    server.registerTool('ask_model', {
      description: 'Ask one ShadowGate model a single question and get its answer. The result shows the model it went to, what was sent, and the full reply (including the model\'s thinking when it returns any).',
      inputSchema: {
        model: z.string().describe('Model id from list_models, e.g. "gpt-6", "gpt-5-6", "gpt-6-astra-wm". Only free models are allowed here; metered -codex models are refused.'),
        prompt: z.string().describe('The question or instruction for the model.'),
        system: z.string().optional().describe('Optional system instruction to steer the model.'),
        effort: z.string().optional().describe('Optional thinking effort: minimal, low, medium or high.'),
      },
    }, async ({ model, prompt, system, effort }) => {
      const info = await modelRows(key);
      if (!info) return textResult('Could not check the model list, so nothing was sent.');
      if (isMetered(model, info.metered)) return textResult(blockedText(model, info.rows));
      const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ];
      const body = JSON.stringify({ model, messages, ...(effort ? { reasoning_effort: effort } : {}) });
      const r = await v1('/v1/chat/completions', key, { method: 'POST', body });
      const j: any = await r.json().catch(() => null);
      if (!r.ok || !j) return textResult(`ShadowGate returned HTTP ${r.status}${j?.error?.message ? `: ${j.error.message}` : ''}.`);
      const m = j.choices?.[0]?.message;
      const served = j.model || model;
      const u = j.usage ? ` · ${j.usage.total_tokens} tokens` : '';
      const sent = `→ ShadowGate · requested "${model}"${effort ? ` · effort ${effort}` : ''}${system ? `\nSystem: ${short(system, 300)}` : ''}\nPrompt: ${short(prompt, 500)}`;
      const answer = m?.content?.trim() || '(the model returned no text)';
      const thinking = m?.reasoning_content?.trim() ? `\n\n[thinking]\n${m.reasoning_content.trim()}` : '';
      return textResult(`${sent}\n\n← answered by "${served}"${u}:\n${answer}${thinking}`);
    });

    server.registerTool('usage', {
      description: 'Current ShadowGate usage: the ChatGPT account limits (5-hour and weekly) and this key\'s own gateway usage.',
      inputSchema: {},
    }, async () => {
      const r = await v1('/v1/usage?format=text', key);
      const t = await r.text().catch(() => '');
      return textResult(r.ok ? t : `Could not read usage (HTTP ${r.status}).`);
    });

    if (connectors.length) {
      const names = connectors.map((c) => c.name).join(', ');
      server.registerTool('run_task', {
        description:
          `Have a ShadowGate model carry out a task by operating a connected tool server (${names}). ` +
          'The model plans, calls that server\'s tools step by step, and reports the result. ' +
          'Returns the exact steps it took so you can see what happened. Use this for actions, not just chatting.',
        inputSchema: {
          task: z.string().describe('What to accomplish, in plain language.'),
          connector: z.string().optional().describe(`Which tool server to use (${names}). Defaults to the first.`),
          model: z.string().optional().describe(`Which model drives the task. Default ${DEFAULT_AGENT_MODEL} (reliable tool use, light on usage).`),
          max_steps: z.number().int().min(1).max(MAX_STEPS).optional().describe(`Most tool steps to take (default ${MAX_STEPS}).`),
        },
      }, async ({ task, connector, model, max_steps }) => {
        const conn = connector ? connectors.find((c) => c.name.toLowerCase() === connector.toLowerCase()) : connectors[0];
        if (!conn) return textResult(`No connector named "${connector}". Configured: ${names}.`);
        const useModel = model || DEFAULT_AGENT_MODEL;
        const info = await modelRows(key);
        if (!info) return textResult('Could not check the model list, so the task was not started.');
        if (isMetered(useModel, info.metered)) return textResult(blockedText(useModel, info.rows));
        const limit = max_steps || MAX_STEPS;

        const client = new Client({ name: 'shadowgate-agent', version: cfg.version });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
        } catch (e) {
          return textResult(`Could not reach the "${conn.name}" connector: ${(e as Error).message}`);
        }
        try {
          const listed = await client.listTools();
          const toolSpecs = (listed.tools || []).map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: (t.inputSchema as any) || { type: 'object', properties: {} } },
          }));
          if (!toolSpecs.length) return textResult(`The "${conn.name}" connector exposes no tools.`);

          const messages: any[] = [
            { role: 'system', content: `You carry out the user's task by using the tools of "${conn.name}", which act on the user's real machine. You have NO prior knowledge of that machine's current state — its files, processes, windows, settings or anything else — so you must find every answer by calling a tool and reading the result. Never answer from memory or guess a value; always use a tool first. Take one or more actions, check the results, continue until the task is done, then reply with a short plain-text report of what you did and the outcome, with no tool call. Be careful and do only what the task asks.` },
            { role: 'user', content: task },
          ];
          const transcript: string[] = [];
          let final = '';
          let tookAction = false;

          for (let step = 0; step < limit; step++) {
            // force a real tool call until the agent has actually done something, so it cannot fabricate an answer
            const body: any = { model: useModel, messages, tools: toolSpecs };
            if (!tookAction) body.tool_choice = 'required';
            const r = await v1('/v1/chat/completions', key, { method: 'POST', body: JSON.stringify(body) });
            const j: any = await r.json().catch(() => null);
            if (!r.ok || !j) { transcript.push(`! model call failed (HTTP ${r.status}${j?.error?.message ? `: ${j.error.message}` : ''})`); break; }
            const m = j.choices?.[0]?.message;
            const calls = m?.tool_calls || [];
            if (!calls.length) { final = m?.content?.trim() || ''; break; }
            tookAction = true;
            messages.push({ role: 'assistant', content: m.content ?? null, tool_calls: calls });
            for (const c of calls) {
              let args: any = {};
              try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* keep {} */ }
              let out = '';
              try {
                const tr: any = await client.callTool({ name: c.function.name, arguments: args });
                out = (tr.content || []).map((x: any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') || '(done)';
                if (tr.isError) out = `error: ${out}`;
              } catch (e) {
                out = `tool error: ${(e as Error).message}`;
              }
              transcript.push(`${transcript.length + 1}. ${c.function.name}(${short(args)}) → ${short(out, 200)}`);
              messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, TOOL_RESULT_CAP) });
            }
          }
          const head = `Task on "${conn.name}" with ${useModel}:\n${task}`;
          const steps = transcript.length ? `\n\nSteps taken:\n${transcript.join('\n')}` : '\n\n(no tool steps were taken)';
          const tail = `\n\nResult:\n${final || '(stopped before giving a final report — raise max_steps or simplify the task)'}`;
          return textResult(head + steps + tail);
        } finally {
          await client.close().catch(() => {});
        }
      });
    }

    return server;
  }

  app.all('/mcp', async (req: Req, res: Res) => {
    const key = keyFromReq(req);
    const rec: ApiKeyRecord | undefined = key.startsWith('sg-') ? store.keys.find((k) => k.hash === sha256hex(key)) : undefined;
    if (!rec || !rec.enabled) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing, invalid or disabled ShadowGate API key. Use /mcp?key=sg-… or an Authorization: Bearer header.' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed — this endpoint speaks MCP over POST.' }, id: null });
      return;
    }
    const server = buildServer(key);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed:', (e as Error).message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  console.log(`[shadowgate] MCP connector at /mcp${connectors.length ? ` · agent connectors: ${connectors.map((c) => c.name).join(', ')}` : ' (no agent connectors configured)'}`);
}
