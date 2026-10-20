#!/usr/bin/env bash
# Wire ai.shadowvpn.live vhost into the existing nginx; disable caddy.
set -e
systemctl disable --now caddy 2>/dev/null || true

cp /tmp/nginx-shadowgate.conf /etc/nginx/sites-available/shadowgate
ln -sf /etc/nginx/sites-available/shadowgate /etc/nginx/sites-enabled/shadowgate
nginx -t
systemctl reload nginx

echo -n "[*] via nginx (Host header): "
curl -s -m 5 -H "Host: ai.shadowvpn.live" http://127.0.0.1/healthz
echo

if ! command -v certbot >/dev/null; then
  echo "[*] installing certbot…"
  apt-get install -y -q certbot python3-certbot-nginx 2>&1 | tail -1
fi
certbot --version 2>/dev/null || echo "certbot missing"
