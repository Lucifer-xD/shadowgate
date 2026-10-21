# ShadowGate API

Base: `https://<your-host>` — Auth: `Authorization: Bearer sg-…` — CORS: `*` (no cookies on `/v1`).

The live, nicely formatted version of this page is served at **`/docs`** on every deployment.

## POST /v1/chat/completions

```json
{
  "model": "gpt-5",
  "messages": [
    {"role": "system", "content": "You are terse."},
    {"role": "user", "content": "hello, shadow."}
  ],
  "stream": false
}
```

| Field | Notes |
|---|---|
| `model` | Any id from `/v1/models` or an alias (see below); unknown → `auto`. |
| `messages` | `system` / `developer` / `user` / `assistant` / `tool`. String content or an array of parts (`text` parts are joined; images ignored). |
| `stream` | `true` → `text/event-stream`. |
| `reasoning_effort` | `minimal`/`low`/`medium` → `thinking_effort: standard`, `high`/`xhigh` → `extended` (models that support it). `reasoning: {effort}` and ChatGPT's own `standard`/`extended` are accepted too. |
| `tools` / `tool_choice` | OpenAI function calling, **emulated**: the tools are described to the model in a system preamble with a `<tool_call>{json}</tool_call>` protocol; calls come back as real `tool_calls` (`finish_reason: tool_calls`), results go back as `tool` messages. Works with agent harnesses unmodified. |
| `response_format` | `json_object` / `json_schema` → the model is told to answer with bare JSON; fences stripped. |
| `stop`, `max_tokens` | Applied to the visible text; `finish_reason` `stop` / `length`. |
| anything else | Accepted and ignored — the web backend exposes no sampling controls. |

Response (JSON mode):

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "gpt-5",
  "choices": [
    {"index": 0, "message": {"role": "assistant", "content": "hello."}, "finish_reason": "stop"}
  ],
  "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}
}
```

`usage` is estimated (characters ÷ 4) — the upstream does not report token counts.

With `"stream": true` you receive OpenAI-identical frames:

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"…","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}

data: {"…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Reasoning models stream thought summaries as `delta.reasoning_content` (JSON mode: `message.reasoning_content`); `stream_options.include_usage` adds a final usage chunk. Code the model runs on ChatGPT's side and widget placeholders are not forwarded, only the visible answer. `/v1/models` reports `context_length` / `context_window` as the per-request budget that actually fits through ChatGPT's backend (~120k tokens, measured; ~400k characters per request, ~330k per single message) and the model's nominal size as `model_context_tokens`. Oversized single messages are split; an oversized request gets a 413 that states the numbers.

If the upstream stream breaks after output has started, a short bracketed note is appended and the stream is closed cleanly. If the client disconnects, the upstream conversation is aborted immediately.

## GET /v1/models · GET /v1/models/{id}

```json
{"object":"list","data":[{"id":"auto","object":"model","owned_by":"shadowgate"}, …]}
```

The list is discovered from chatgpt.com per session (`/backend-api/models`) and refreshed on every verify: real slugs such as `gpt-5-6`, `gpt-5-6-thinking`, `gpt-5-6-pro`, `gpt-5-6-mini`, each with `title`, `reasoning` lane and `thinking_efforts`; plus `default_model`. OpenAI-style names (`gpt-5`, `gpt-5-thinking`, `gpt-4o`, `o3`, …) are listed as aliases with `alias_of`.

Resolution: an exact slug passes through (dots/dashes interchangeable); `auto`/`gpt-4o`/`gpt-5`/unknown → account default; `*thinking*`, `o1`/`o3`/`o4` or `reasoning_effort: high` → newest reasoning model of the requested generation; `*pro*` → Pro; `*mini*`/`*nano*`/`gpt-3.5` → mini; `*instant*` → instant; `astra`/`luna`/`terra`/`sol`/`gpt-6` → newest model with that codename. Work-mode models (`-wm`, flagged `work_mode: true`) are requested inside a work-mode conversation automatically. The response `model` field and the `x-shadowgate-model` header report what actually answered. A model your plan cannot use returns `429` with the upstream message.

## GET /v1/usage

The ChatGPT account limits behind the pool (the numbers on chatgpt.com → Settings → Usage) plus the calling key's own gateway usage. `?format=text` returns the same as a short plain-text summary.

```json
{"object":"usage","generated_at":"…","accounts":[{"id":"…","label":"Main Account","status":"healthy","plan":"k12",
  "allowed":true,"limit_reached":false,
  "five_hour":{"used_percent":0,"remaining_percent":100,"window_seconds":18000,"resets_at":"…","resets_in_seconds":18000},
  "weekly":{"used_percent":31,"remaining_percent":69,"window_seconds":604800,"resets_at":"…","resets_in_seconds":275414},
  "credits":{"hasCredits":false,"unlimited":false,"overageLimitReached":false,"balance":0},
  "models":{"gpt-6-astra":{"available":true}},"fetched_at":"…"}],
 "key":{"name":"opencode","requests_5h":3,"requests_24h":10,"requests_total":99,"rpm_limit":120,"rpd_limit":20000,"remaining_today":19990},
 "note":"…"}
```

Source: `GET https://chatgpt.com/backend-api/wham/usage` per session, cached two minutes, also refreshed by the ten-minute health check. Work-mode (`-wm`) models spend these limits; the chat lane does not.

**Usage questions in chat.** When the latest user message asks about usage or limits (English or Arabic; coding phrases such as "usage of this function" are ignored), the gateway appends a `[ShadowGate usage: …]` note with the live summary to that message, so the model answers from real data in any client. The note is stripped from continuation keys, so it never forces a full resend. The request log notes `usage attached`.

## Errors

OpenAI-shaped: `{"error": {"message", "type", "param": null, "code": null}}`.

| Status | Type | When |
|---|---|---|
| 400 | invalid_request_error | Malformed JSON, invalid messages |
| 401 | authentication_error | Missing/unknown API key |
| 403 | permission_error | Key disabled |
| 413 | invalid_request_error | Body > 2 MB or messages > 400k chars |
| 429 | rate_limit_error | Key limit (`retry-after` header) or plan model cap |
| 502 | upstream_error | ChatGPT refused/dropped the conversation after retries |
| 503 | service_unavailable | No healthy sessions in the pool |

Rate limits: per key, sliding windows (default 120/min, 20 000/day). `GET /v1/models` is not counted.

## Admin API

`/api/admin/*` — cookie session (`sg_admin`, HttpOnly, SameSite=Strict) + `x-csrf-token` header on every non-GET request. The console is the intended client; see `src/admin.ts` for the surface: `login`, `logout`, `session`, `stats`, `usage`, `keys` (CRUD), `tokens` (CRUD + `/:id/verify`), `logs`, `audit`, `settings`, `password`, `totp/setup|enable|disable`, `sessions/revoke`.
