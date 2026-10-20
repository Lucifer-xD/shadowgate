# ShadowGate — operator handoff

Working notes for whoever operates a ShadowGate deployment. Nothing in this
file is specific to one person's machine or server; keep your own hostnames,
paths and credentials in a private notes file outside the repository.

## Layout of a production install

| What | Where (typical) |
|---|---|
| App (dist + web + production node_modules) | `/opt/shadowgate` |
| Environment (secrets) | `/opt/shadowgate/.env`, owned `root:shadowgate`, mode `0600` |
| Data (encrypted store, chats, continuation links) | `/opt/shadowgate/data/` (`store.json`, `chats.json`, `continuation.json`) |
| Node runtime | `/opt/node` (tarball install, see `deploy/deploy.sh`) |
| Service | `systemctl status shadowgate` — logs with `journalctl -u shadowgate` |
| Reverse proxy | nginx vhost from `deploy/nginx-shadowgate.conf` (SSE-safe: `proxy_buffering off`); TLS via certbot (`deploy/issue-cert.sh`) |
| Bind address | `127.0.0.1` only (`BIND_HOST` in `.env`); public access only through the proxy / CDN |
| Rollback copies | `/var/backups/shadowgate/app-v<version>/` — one per deploy |

The app is a single Node 22 process with two runtime dependencies (express,
bcryptjs). Build with `npm run build` (TypeScript → `dist/`), serve `web/`
statically.

## Deploying a new version

1. `npm run build && npm test` locally.
2. Bundle `dist web package.json package-lock.json` (never `openapi.json` or
   anything under `data/`).
3. On the server: copy the previous `/opt/shadowgate` app files to
   `/var/backups/shadowgate/app-v<old>/`, unpack the bundle over
   `/opt/shadowgate`, run `/opt/node/bin/npm ci --omit=dev`, `chown -R
   shadowgate:shadowgate`, `systemctl restart shadowgate`.
4. Verify: `curl https://<host>/healthz` shows the new version;
   `node scripts/verify-production.mjs <admin-password>` runs a login, a
   completion and a streamed completion through the domain.

`.env` and `data/` are never part of a deploy.

## Secrets

- `SECRET_KEY` encrypts the stored ChatGPT session and access tokens
  (AES-256-GCM) and signs admin cookies. Rotating it requires re-encrypting
  the token records in `data/store.json` with the new key (decrypt with the
  old key, encrypt with the new one) while the service is stopped; admin
  sessions are invalidated, API keys and settings are unaffected.
- `ADMIN_PASSWORD` seeds the first admin password; change it in Settings →
  Password after first login and enable TOTP.
- API keys are minted in the console (`sg-…`), shown once, stored as SHA-256.
- If a secret ever lands in git, treat it as burned: rotate it, then rewrite
  history before sharing the repository.

## Architecture quick-facts

- `src/chatgpt/` — PoW sha3-512 solver, session refresh, sentinel handshake,
  SSE → OpenAI translation, image uploads. `docs/astra-request-flow.md` walks
  the upstream protocol end to end, including the slug echo trap.
- `src/pool.ts` — session pool (health loop, cooldowns, catalog per account).
  Work-mode models (`-wm` slugs) are listed under clean names and sent upstream
  in a work-mode conversation (`conversation_origin: "tpp"`).
- `src/gateway.ts` — `/v1` (models, chat completions, emulated function
  calling, history compaction, heartbeats, stop/max_tokens/JSON mode).
- `src/tools.ts` — the Hermes-style tool protocol injected for harnesses.
- `src/admin.ts`, `src/chats.ts`, `src/engine.ts` — console API, built-in
  chat, shared completion loop. `src/store.ts` — encrypted JSON store with
  atomic debounced writes.
- Web: `web/assets/base.css` is the design system ("ember on obsidian").
  No inline scripts (CSP); `npm run check:web` enforces it and the `?v=`
  cache-busters.
- Anti-bot: reuse a session's original device id + User-Agent (from the
  export JSON) or chatgpt.com serves turnstile challenges. Sentinel tokens are
  single-use. `thinking_effort` (standard/extended) is the field the backend
  honours.

## Useful scripts (`scripts/`)

- `check-web.mjs` — CSP / cache-buster guard (CI)
- `verify-session.mjs <file-or-token>` — validate a session against chatgpt.com (masked output)
- `e2e-test.mjs` — local end-to-end test using `.env`
- `seed-from-export.mjs <session-file> [label]` — add a session via the admin API
- `gen-traffic.mjs <sg-key>` — dashboard demo traffic
- `screenshot.mjs` — regenerate `docs/screenshots/*`
- `verify-production.mjs <admin-pw>` — production smoke test
