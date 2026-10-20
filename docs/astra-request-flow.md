# Talking to GPT-6 Astra on chatgpt.com — the request flow

This is the minimal, end-to-end flow ShadowGate uses to get a reply from the
real GPT-6 Astra model through a normal ChatGPT session. Four HTTP calls, one
proof-of-work, one SSE stream. Everything below was verified on 2026-10-20.

```
browser cookie ──► 1. GET  /api/auth/session                 → access token
                   2. POST /backend-api/sentinel/chat-requirements → sentinel token (+ PoW seed)
                   3. POST /backend-api/conversation          → SSE stream
                   4. read the stream: message.metadata.model_slug === "gpt-6-astra-wm"
```

## Read this first: the echo trap

chatgpt.com accepts **any** model slug and echoes it back as `model_slug` in
every frame. `gpt-6-astra`, `gpt-6`, even `gpt-9-zeus` all "work": HTTP 200,
a sensible reply, and metadata that repeats the name you sent. They are all
the same thing — the plan's fallback lane. Measured on the same account, same
prompt, same minute:

| sent | `requested_model_experience` | sandbox tool used | system-prompt name |
|---|---|---|---|
| `gpt-6-astra` (bare) | `instant` | `PythonCaasCotTool` | "GPT-6" |
| `gpt-9-zeus` (made up) | `instant` | `PythonCaasCotTool` | "GPT-6" |
| `gpt-5-6` | `instant` | `PythonCaasCotTool` | "GPT-5.6 Sol" |
| `gpt-6-astra-wm` + `conversation_origin: "tpp"` | `work` | `ContainerTool` | "ChatGPT" / "GPT-5" |

The bare name and the made-up name are indistinguishable. The only request
that reaches a different model is the **work-mode slug inside a work-mode
conversation**. Without `conversation_origin: "tpp"` the `-wm` slug silently
falls back to `gpt-5-6`. Nothing in the reply flags either fallback, so send
the work-mode form and the field, always, and only use slugs that appear in
the account's own model list (`GET /backend-api/models`, where the GPT-6
family is flagged `is_work_mode_model: true`).

## 0. What you need from the browser

Log in to chatgpt.com in a browser and take three things from it:

| Item | Where | Used as |
|---|---|---|
| `__Secure-next-auth.session-token` cookie | DevTools → Application → Cookies | proves you are logged in (lives for weeks) |
| `oai-device-id` | the `oai-did` cookie, or any request header on chatgpt.com | `oai-device-id` header on every call |
| the browser's User-Agent string | any request header | `user-agent` header on every call, and inside the PoW fingerprint |

Keep the device id and User-Agent **paired with the session**: the backend
fingerprints the pair.

## 1. Session token → access token

```http
GET https://chatgpt.com/api/auth/session
cookie: __Secure-next-auth.session-token=<session token>
oai-device-id: <device id>
user-agent: <browser UA>
```

Response (trimmed):

```json
{ "accessToken": "eyJhbGciOi…", "expires": "2026-10-30T12:00:00.000Z", "user": { … } }
```

The access token is a JWT valid for about ten days. Re-run this call when it
expires; the cookie keeps working.

Common headers for every call from here on:

```http
authorization: Bearer <accessToken>
oai-device-id: <device id>
oai-language: en-US
user-agent: <browser UA>
origin: https://chatgpt.com
referer: https://chatgpt.com/
```

Add `chatgpt-account-id: <id>` if the session belongs to a workspace account
(`user.accountId` or the `accounts` map in the session reply).

## 2. Sentinel requirements + proof of work

Every conversation request must carry a one-shot sentinel token. Ask for it:

```http
POST https://chatgpt.com/backend-api/sentinel/chat-requirements
content-type: application/json

{ "p": "gAAAAAC<base64 fingerprint answer>" }
```

Response:

```json
{
  "token": "gAAAAAB…",
  "proofofwork": { "required": true, "seed": "0.123456789", "difficulty": "0fffff" },
  "turnstile": { "required": false }
}
```

### The proof of work

It is a sha3-512 search over a JSON "fingerprint" array. The array has 18
slots; two of them are the nonce and the elapsed time, which change every
iteration:

```js
config = [
  screenWidth,            // 0  e.g. 3000
  localTimeString,        // 1  "Mon Oct 20 2026 13:00:00 GMT+0800 (中国标准时间)"
  4294705152,             // 2  constant
  0,                      // 3  NONCE   ← changes each iteration
  userAgent,              // 4  must equal the user-agent header
  scriptUrl,              // 5  any <script src> from chatgpt.com's HTML (or null)
  buildId,                // 6  data-build="…" from chatgpt.com's HTML
  "en-US", "en-US",       // 7, 8
  0,                      // 9  ELAPSED MS ← changes each iteration
  "webkitGetUserMedia−function webkitGetUserMedia() { [native code] }", // 10 (U+2212 minus)
  "location",             // 11
  "ontransitionend",      // 12
  timeFloat,              // 13 ms since start + fraction
  sessionUuid,            // 14 random uuid, fixed per process
  "",                     // 15
  cores,                  // 16 e.g. 8
  startTimeMs             // 17 process start
]
```

Search:

```js
for (nonce = 0; nonce < 500000; nonce++) {
  config[3] = nonce; config[9] = msSinceSearchStart;
  base = base64(JSON.stringify(config));
  hash = sha3_512_hex(seed + base);
  if (hash.slice(0, difficulty.length) <= difficulty) return base;   // answer
}
```

Two proofs are needed:

* `p` for step 2 — seed is any random string, difficulty `"0"` (always solves
  on the first try). Prefix the answer with `gAAAAAC`.
* the conversation proof for step 3 — seed and difficulty come from
  `proofofwork` in the step-2 reply. Prefix the answer with `gAAAAAB` and send
  it as the `openai-sentinel-proof-token` header. Difficulty `0fffff` solves
  in a few thousand hashes, well under a second.

The token is **single-use**. Fetch a new one for every conversation request;
reusing one gets `403 Unusual activity has been detected from your device`.

ShadowGate's exact implementation is `src/chatgpt/pow.ts`.

## 3. The conversation request

```http
POST https://chatgpt.com/backend-api/conversation
accept: text/event-stream
content-type: application/json
authorization: Bearer <accessToken>
oai-device-id: <device id>
openai-sentinel-chat-requirements-token: <token from step 2>
openai-sentinel-proof-token: gAAAAAB<answer>
```

```json
{
  "action": "next",
  "conversation_mode": { "kind": "primary_assistant" },
  "model": "gpt-6-astra-wm",
  "conversation_origin": "tpp",
  "thinking_effort": "extended",
  "history_and_training_disabled": true,
  "force_use_sse": true,
  "parent_message_id": "<new uuid>",
  "websocket_request_id": "<new uuid>",
  "messages": [
    {
      "id": "<new uuid>",
      "author": { "role": "user" },
      "content": { "content_type": "text", "parts": ["Explain what a semaphore is in about 150 words."] }
    }
  ]
}
```

The two lines that matter are `"model": "gpt-6-astra-wm"` and
`"conversation_origin": "tpp"`. The slug comes from the account's
`GET /backend-api/models`; the origin field is what chatgpt.com's own
work-mode client sends (found in the site's JavaScript bundle). Verified
behaviour on 2026-10-20:

| `model` sent | `conversation_origin` | result |
|---|---|---|
| `gpt-6-astra-wm` | `"tpp"` | HTTP 200, `model_slug: "gpt-6-astra-wm"`, experience `work` — **the real model** |
| `gpt-6-astra-wm` | (none) | HTTP 200 but silently served as `gpt-5-6` |
| `gpt-6-astra` (bare) | (none) | HTTP 200, echoes `model_slug: "gpt-6-astra"`, but it is the fallback lane — identical to sending `gpt-9-zeus` |
| `gpt-5.6-terra` (bare) | (none) | HTTP 200 but silently served as `gpt-5-6` |

The same holds for `gpt-6-luna-wm`, `gpt-6-sol-wm`, `gpt-6.1-sol-wm`,
`gpt-5.6-terra-wm`, `gpt-5.6-luna-wm` and `gpt-5.6-sol-wm`. On a plan whose
model list does not carry these slugs the backend answers
`{"detail":"Access denied. Please try using another model."}`; there is no
way around that from the client side.

Field notes:

* `thinking_effort` — `"standard"` or `"extended"`; omit it for the backend's
  default. (`reasoning_effort` is ignored by the backend; ShadowGate translates
  OpenAI's levels to these two.)
* `history_and_training_disabled: true` — temporary chat; nothing is saved to
  the account's history.
* To continue a conversation, send only the new user message with
  `conversation_id` and `parent_message_id` set to the last assistant message
  id from the previous stream. ShadowGate instead resends the whole history as
  separate messages each time (stateless, like the OpenAI API), with the
  system prompt as `author.role: "critic"`; the backend echoes them back, so
  skip your own message ids when reading the stream.
* Per-request limit is about 480k characters of text; a single message above
  roughly 330k characters is rejected with `message_length_exceeds_limit`.
* `/backend-api/f/conversation`, the newer path chatgpt.com's client uses,
  behaves exactly like `/backend-api/conversation` for everything here.

## 4. Reading the stream

The reply is `text/event-stream`. Each `data:` line is JSON; the stream ends
with `data: [DONE]`. The frames that matter:

```json
data: {"message": {
  "id": "…",
  "author": { "role": "assistant" },
  "status": "in_progress",
  "content": { "content_type": "text", "parts": ["A semaphore is a signaling system"] },
  "metadata": { "model_slug": "gpt-6-astra-wm", "message_type": "next" },
  "recipient": "all"
}, "conversation_id": "…"}
```

Rules that produce a clean reply:

1. Only frames with `author.role === "assistant"` and
   `content.content_type` of `text` or `multimodal_text` are visible text.
   Ignore `recipient !== "all"` (tool calls to the sandbox), `thoughts`
   (reasoning summaries, show them as "thinking" if you like), and messages
   with `metadata.is_visually_hidden_from_conversation`.
2. `parts[0]` is the **full text so far**, not a delta. Emit the suffix beyond
   what you already printed. After the first full frame the backend switches
   to delta frames for the same message: `{"v": {"message": …}}` (a wrapped
   full frame), `{"p": "/message/content/parts/0", "o": "append", "v": "…"}`
   (append to the text), or `{"o": "patch", "v": [ …ops… ]}` (a batch of such
   operations, which may also set `/message/status` or `/message/metadata`).
   Apply them to the last message you saw.
3. The message is complete when `status` becomes `finished_successfully`.
4. `metadata.model_slug` only confirms the backend accepted your slug (see the
   echo trap); the `server_ste_metadata` frame near the end of the stream
   carries `requested_model_experience` (`work` for the GPT-6 family) and the
   sandbox `tool_name`, which is what actually changes.
5. Strip private-use characters U+E200…U+E20F (citation/widget markers) from
   the text.

## 5. One file that does the whole flow

```js
// node >= 20. Fill in the three values from the browser.
import { createHash, randomUUID } from 'node:crypto';

const SESSION_TOKEN = '<__Secure-next-auth.session-token>';
const DEVICE_ID = '<oai-device-id>';
const UA = '<browser user-agent>';

const BASE = 'https://chatgpt.com';
const start = Date.now();
const sid = randomUUID();

function answer(seed, difficulty) {
  const t0 = Date.now();
  const cfg = [3000, new Date().toString(), 4294705152, 0, UA, null,
    'prod-a696433ddfe0489db6696cae8c5778c2128f26e8', 'en-US', 'en-US', 0,
    'webkitGetUserMedia−function webkitGetUserMedia() { [native code] }',
    'location', 'ontransitionend', Date.now() - start + Math.random(), sid, '', 8, start];
  for (let i = 0; i < 500000; i++) {
    cfg[3] = i; cfg[9] = Date.now() - t0;
    const b = Buffer.from(JSON.stringify(cfg)).toString('base64');
    if (createHash('sha3-512').update(seed + b).digest('hex').slice(0, difficulty.length) <= difficulty) return b;
  }
  throw new Error('no PoW answer');
}

// 1. access token
const session = await (await fetch(`${BASE}/api/auth/session`, {
  headers: { 'user-agent': UA, cookie: `__Secure-next-auth.session-token=${SESSION_TOKEN}`, 'oai-device-id': DEVICE_ID },
})).json();
const H = {
  'user-agent': UA, authorization: `Bearer ${session.accessToken}`, 'oai-device-id': DEVICE_ID,
  'oai-language': 'en-US', origin: BASE, referer: `${BASE}/`, 'content-type': 'application/json', accept: '*/*',
};

// 2. sentinel token + proof of work (fresh for every request)
const req = await (await fetch(`${BASE}/backend-api/sentinel/chat-requirements`, {
  method: 'POST', headers: H, body: JSON.stringify({ p: 'gAAAAAC' + answer(String(Math.random()), '0') }),
})).json();
const proof = req.proofofwork?.required ? 'gAAAAAB' + answer(req.proofofwork.seed, req.proofofwork.difficulty) : '';

// 3. the conversation — the work-mode slug inside a work-mode conversation
const r = await fetch(`${BASE}/backend-api/conversation`, {
  method: 'POST',
  headers: { ...H, accept: 'text/event-stream', 'openai-sentinel-chat-requirements-token': req.token, ...(proof ? { 'openai-sentinel-proof-token': proof } : {}) },
  body: JSON.stringify({
    action: 'next',
    conversation_mode: { kind: 'primary_assistant' },
    model: 'gpt-6-astra-wm',
    conversation_origin: 'tpp',     // without this the -wm slug silently falls back to gpt-5-6
    thinking_effort: 'extended',
    history_and_training_disabled: true,
    force_use_sse: true,
    parent_message_id: randomUUID(),
    websocket_request_id: randomUUID(),
    messages: [{ id: randomUUID(), author: { role: 'user' }, content: { content_type: 'text', parts: ['Explain what a semaphore is in about 150 words.'] } }],
  }),
});
if (r.status !== 200) throw new Error(`conversation -> ${r.status} ${await r.text()}`);

// 4. read the stream (full frames first, then delta/patch frames for the same message)
let buf = '', printed = '', slug = '', experience = '', last = null;
const dec = new TextDecoder();
const show = (m) => {
  if (!m || m.author?.role !== 'assistant' || m.content?.content_type !== 'text' || (m.recipient && m.recipient !== 'all')) return;
  last = m;
  slug = m.metadata?.model_slug ?? slug;
  const full = (m.content.parts?.[0] ?? '').replace(/[-]/g, '');
  if (full.startsWith(printed)) { process.stdout.write(full.slice(printed.length)); printed = full; }
};
for await (const chunk of r.body) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    let v; try { v = JSON.parse(line.slice(6)); } catch { continue; }
    if (v.type === 'server_ste_metadata') { experience = v.metadata?.requested_model_experience ?? ''; continue; }
    if (v.message) { show(v.message); continue; }                 // full frame
    if (v.v && typeof v.v === 'object' && !Array.isArray(v.v) && v.v.message) { show(v.v.message); continue; } // wrapped full frame
    const ops = v.o === 'patch' && Array.isArray(v.v) ? v.v : (v.v !== undefined ? [v] : []);
    for (const op of ops) {                                        // delta frames
      if (!last) continue;
      const path = typeof op.p === 'string' ? op.p : '/message/content/parts/0';
      if (path === '/message/content/parts/0' && typeof op.v === 'string') {
        last.content.parts[0] = op.o === 'replace' ? op.v : (last.content.parts[0] ?? '') + op.v;
        show(last);
      } else if (path === '/message/status' && typeof op.v === 'string') last.status = op.v;
      else if (path === '/message/metadata' && op.v && typeof op.v === 'object') last.metadata = { ...last.metadata, ...op.v };
    }
  }
}
console.log(`\n\n[answered by ${slug}, experience: ${experience}]`);
```

Expected output: the explanation streams in as it is written, then

```
[answered by gpt-6-astra-wm, experience: work]
```

`experience: work` is the proof you reached the real model. A bare slug prints
`experience: instant` no matter what name you sent.

## 6. Things that bite

* **401** on any call: the access token expired → repeat step 1. If step 1
  itself fails, the cookie is dead; log in again in the browser.
* **403 `Unusual activity has been detected from your device`**: a sentinel
  token was reused, or the PoW answer does not match the fingerprint
  (User-Agent must be identical everywhere). Fetch a fresh token for every
  conversation request. The flag can stick to the device id for a while.
* **403 `Access denied. Please try using another model.`**: the account's plan
  does not include that model. Check `GET /backend-api/models` for the
  account: if no `-wm` slugs are listed, the plan has no GPT-6 family and no
  trick reaches it — use `gpt-5-6`, `gpt-5-6-thinking` and so on.
* **429** with `model_cap_reached`: the plan's usage cap for that model.
* **A bare slug "works"**: it is the echo trap from the top of this document,
  not the model you asked for.
* Images: upload first (`POST /backend-api/files` → PUT the bytes to the
  returned Azure `upload_url` with `x-ms-blob-type: BlockBlob` →
  `POST /backend-api/files/{id}/uploaded`), then send
  `content_type: "multimodal_text"` with an
  `{"content_type":"image_asset_pointer","asset_pointer":"file-service://<id>","size_bytes":…,"width":…,"height":…}`
  part before the text. ShadowGate's `src/chatgpt/images.ts` has the details.
* The model list for the account is `GET /backend-api/models` (real slugs,
  `max_tokens` = context window, `thinking_efforts`, `is_work_mode_model`).
  Send only slugs from that list; anything else is answered by the echo.
