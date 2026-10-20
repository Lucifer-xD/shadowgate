# Security model

ShadowGate is deliberately paranoid for something that guards live ChatGPT sessions.

## Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Server disk theft / backup leak | Session + access tokens are AES-256-GCM encrypted (`SECRET_KEY`-derived). IPs stored as salted SHA-256 prefixes. |
| Stolen API key | Keys stored as SHA-256; shown once; per-key rpm/rpd limits; can be disabled/deleted instantly. |
| Brute-forcing the console | bcrypt(12) with a dummy compare for unknown usernames (timing-flat), 5 failures → 15-minute lockout per visitor — wrong 2FA codes count too — optional TOTP 2FA with a 10-minute setup window. |
| Lockout keyed on the wrong address | `TRUST_PROXY` makes the gateway read the real client IP behind nginx/Caddy; `deploy/nginx-cloudflare-realip.conf` restores it behind Cloudflare, so one attacker cannot lock the operator out and the allowlist is meaningful. |
| Session hijacking (XSS/CSRF) | Signed HttpOnly SameSite=Strict cookies, CSRF double-submit header on mutations (token kept in memory only), strict CSP (`script-src 'self'`, no inline scripts, enforced by CI), `X-Frame-Options: DENY`, server-side session version for instant revocation. |
| Traffic interception | TLS terminated by nginx (certbot) or Caddy; HSTS; Secure cookie flag behind HTTPS; the app binds `127.0.0.1` behind the proxy. |
| Request flooding | Per-key sliding windows + 2 MB body cap + 400k-char message cap; aborted upstream calls when the client disconnects. |
| Supply chain | 2 runtime dependencies (`express`, `bcryptjs`), lockfile committed, no postinstall scripts, CI type-checks every push. |
| Data leakage in errors | Upstream error details are truncated; stack traces never leave the process; malformed JSON gets a generic message. |
| Secrets in the repository | `.env`, deploy bundles and scratch secret files are git-ignored; nothing in `web/` or `docs/` carries credentials. |

## Operational hardening checklist (production)

- [x] Dedicated `shadowgate` system user, no shell
- [x] systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `ProtectHome`
- [x] Data directory `0700`, store file `0600`
- [x] Firewall: only 22/80/443 exposed; app bound to `127.0.0.1`
- [x] Logs via journald (owned by root, rotated)
- [ ] Rotate `SECRET_KEY` + admin password if either was ever committed or shared
- [ ] Optional: `ADMIN_IP_ALLOWLIST` for the console
- [ ] Optional: TOTP 2FA enabled in Settings

## Reporting

This is a private project. If you find an issue, patch it and push — or open a ticket in the tracker.
