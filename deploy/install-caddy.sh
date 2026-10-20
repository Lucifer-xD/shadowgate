#!/usr/bin/env bash
# Caddy install (static binary + systemd) — run as root.
set -e
if [ ! -x /usr/bin/caddy ]; then
  echo "[*] downloading caddy…"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/bin/caddy
  chmod +x /usr/bin/caddy
fi
/usr/bin/caddy version

cat > /etc/caddy/Caddyfile <<'EOF'
ai.shadowvpn.live {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4315 {
		flush_interval -1
		transport http {
			response_header_timeout 5m
		}
	}
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}
}
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now caddy
sleep 2
echo "[*] caddy: $(systemctl is-active caddy)"
