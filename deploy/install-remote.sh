#!/usr/bin/env bash
# ShadowGate remote installer — run as root on the VPS.
# env: SK (secret key), AP (admin password)
set -e
SK="${SK:?need SK}" AP="${AP:?need AP}"

if [ ! -x /opt/node/bin/node ]; then
  echo "[*] installing node 22…"
  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /opt
  mv /opt/node-v22.14.0-linux-x64 /opt/node
  rm -f /tmp/node.tar.xz
fi
echo "[*] node: $(/opt/node/bin/node --version)"

id -u shadowgate >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin shadowgate
mkdir -p /opt/shadowgate/data
rm -rf /tmp/sg-unpack
mkdir -p /tmp/sg-unpack
tar -xzf /tmp/shadowgate-bundle.tar.gz -C /tmp/sg-unpack
cp -r /tmp/sg-unpack/dist /tmp/sg-unpack/web /tmp/sg-unpack/package.json /tmp/sg-unpack/package-lock.json /opt/shadowgate/
cd /opt/shadowgate
/opt/node/bin/npm ci --omit=dev --no-audit --no-fund | tail -1

cat > /opt/shadowgate/.env <<EOF
PORT=4315
PUBLIC_BASE_URL=https://ai.shadowvpn.live
SECRET_KEY=$SK
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$AP
SESSION_TOKENS=
TRUST_PROXY=1
EOF
chmod 600 /opt/shadowgate/.env
chown -R shadowgate:shadowgate /opt/shadowgate

cp /tmp/sg-unpack/deploy/shadowgate.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shadowgate
sleep 2
echo "[*] service: $(systemctl is-active shadowgate)"
echo -n "[*] healthz: "
curl -s http://localhost:4315/healthz
echo
