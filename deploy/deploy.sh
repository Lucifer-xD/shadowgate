#!/usr/bin/env bash
# ShadowGate — production deploy reference (Ubuntu 22.04 / 24.04)
# Run from the repo root on the server (or adapt for rsync-from-local).
set -euo pipefail

APP_DIR=/opt/shadowgate
NODE_DIR=/opt/node
NODE_VER=v22.14.0

echo "── ShadowGate deploy ──"

# 1. Node runtime (tarball, no apt flakiness)
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "installing Node $NODE_VER…"
  ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; esac
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$ARCH.tar.xz" \
    | sudo tar -xJ -C /opt
  sudo mv /opt/node-$NODE_VER-linux-$ARCH "$NODE_DIR"
fi

# 2. App user + layout
sudo id -u shadowgate &>/dev/null || sudo useradd -r -s /usr/sbin/nologin shadowgate
sudo mkdir -p "$APP_DIR/data"
sudo cp -r dist web package.json package-lock.json "$APP_DIR/"
cd "$APP_DIR"
sudo "$NODE_DIR/bin/npm" ci --omit=dev --no-audit --no-fund

# 3. Secrets
if [ ! -f "$APP_DIR/.env" ]; then
  sudo cp .env.example "$APP_DIR/.env"
  echo "!! fill in $APP_DIR/.env (SECRET_KEY, ADMIN_PASSWORD, SESSION_TOKENS) then re-run"
  exit 1
fi

# 4. systemd
sudo cp deploy/shadowgate.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shadowgate

# 5. TLS — Caddy (simplest). If nginx already runs on the box, skip this and use
#    deploy/setup-nginx.sh + deploy/issue-cert.sh instead (certbot --nginx).
if ! command -v caddy &>/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi
sudo cp Caddyfile /etc/caddy/Caddyfile 2>/dev/null || sudo cp Caddyfile /etc/caddy/caddy_file
sudo systemctl reload caddy || sudo systemctl restart caddy

# 6. Firewall
sudo ufw allow 22/tcp; sudo ufw allow 80/tcp; sudo ufw allow 443/tcp
sudo ufw --force enable

echo "✓ deployed — console at https://<your-domain>/admin (first-boot password is in: journalctl -u shadowgate)"
