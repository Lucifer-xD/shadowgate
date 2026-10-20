# Architecture

```
                    ┌────────────────────────────────────────────────┐
                    │                 ShadowGate (Node)              │
                    │                                                │
 client ──Bearer──▶ │  /v1/*    keys ── rate-limit ──▶  gateway.ts   │
 (OpenAI SDK)       │                                        │       │
                    │                                 pick() │ LRU   │
                    │                                        ▼       │
                    │  /api/admin/* ◀── console SPA      pool.ts     │
                    │  bcrypt + lockout + TOTP + CSRF      │         │
                    │                                      ▼         │
                    │  store.json ◀── AES-256-GCM      chatgpt/     │
                    │  (sessions, keys, logs, audit)    client.ts    │
                    └────────────────────────────────────┬───────────┘
                                                         │ HTTPS
                                                         ▼
                                              chatgpt.com backend-api
```

## Request lifecycle (`POST /v1/chat/completions`)

1. **Auth** — `Authorization: Bearer sg-…` is SHA-256 hashed and looked up; disabled/unknown keys are rejected with OpenAI-shaped errors.
2. **Rate limit** — sliding windows per key (rpm = last 60 s, rpd = last 24 h); `retry-after` is computed from the oldest hit in the window. `GET /v1/models` is exempt.
3. **Validation** — roles, content shape, 400k-character cap. `developer` is folded into `system`.
4. **Pool selection** — least-recently-used session among `healthy`/`unverified` and not cooling. Sessions that failed with 401/403/429 during this request are excluded from the next attempt; network blips and 5xx may retry the same session (keep-alive resets are common).
5. **Access token** — decrypted from the store; refreshed from `__Secure-next-auth.session-token` if older than 6 days or after an auth failure.
6. **Sentinel handshake** — `POST /backend-api/sentinel/chat-requirements` with a `gAAAAAC` proof-of-work answer; the response carries a requirements token plus a fresh PoW seed/difficulty.
7. **PoW solve** — SHA3-512 brute force over a browser-fingerprint config array (cores, screen, build id, UA, timing), identical to the web client's algorithm; produces the `gAAAAAB…` proof header.
8. **Conversation** — `POST /backend-api/conversation` with SSE; system messages become `critic` role, history is preserved, `history_and_training_disabled: true`. The upstream request is tied to the client's connection: if the client disconnects, the upstream is aborted.
9. **Translation** — the SSE stream is filtered (role/recipient/message-type gates) and re-emitted as OpenAI `chat.completion.chunk` frames; JSON mode aggregates the same deltas. Headers are written once, so a retry after a failed first attempt continues the same stream.
10. **Resilience** — 401 marks the session `expired` (re-checked hourly); 403/429 cool it down 3 minutes; four generic failures cool it 5 minutes; network errors on our side (timeouts, resets, DNS) cool it only 20 seconds after three strikes, and when no session is healthy a cooling one is still tried rather than refusing the request. Up to 3 attempts per request. An inline quota error from ChatGPT ("You've hit your limit") marks that model capped on that session for an hour and the request fails over to another session; `429` only when none can serve it.
11. **Observability** — every call is logged (status, latency, model, chars, error; `499` = client disconnected) and rolled into dashboard stats; admin actions land in the audit trail.

## Session identity matters

Each session record stores its own `deviceId` + `userAgent`. When you paste a full session export, ShadowGate reuses the **exact device identity the session was created with** — this dramatically reduces sentinel challenges compared to random fingerprints. The console sends your paste to the server untouched so this information is never lost.

## Storage

`data/store.json` — every mutation marks the store dirty and an atomic write (tmp + rename, `0600`) follows within 300 ms; many mutations coalesce into one write. `SIGINT`/`SIGTERM` flush synchronously and close the server so `systemctl restart` is instant. Requests are capped at 5000 entries, audit at 1000. Chosen over SQLite for zero native deps; write volume is low for a personal gateway. A corrupt file is moved aside as `store.json.bak` rather than crashing the boot.

## Web

`web/` is dependency-free vanilla HTML/CSS/JS served by the same process (landing `/`, docs `/docs`, console `/admin`). No build step. The CSP is `script-src 'self'` with zero inline scripts — `npm run check:web` fails CI if one sneaks in. Fonts come from Google Fonts (the only third-party origin, allowed in `style-src`/`font-src`).

## Deployment

`deploy/shadowgate.service` runs the process as an unprivileged user with systemd hardening; `deploy/nginx-shadowgate.conf` proxies TLS (certbot) to `127.0.0.1:4315` with buffering off for SSE. Behind Cloudflare, `deploy/nginx-cloudflare-realip.conf` restores the visitor IP so lockouts and allowlists apply to the real client (`TRUST_PROXY=1`).
