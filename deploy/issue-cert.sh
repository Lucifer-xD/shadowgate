#!/usr/bin/env bash
# Issue a Let's Encrypt certificate for the gateway host via the existing nginx vhost.
# Usage: DOMAIN=ai.example.com CERTBOT_EMAIL=you@example.com ./issue-cert.sh
set -e
: "${DOMAIN:?set DOMAIN}"
: "${CERTBOT_EMAIL:?set CERTBOT_EMAIL}"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  -m "$CERTBOT_EMAIL" --redirect 2>&1 | tail -8
echo "---VHOST-AFTER---"
ls /etc/letsencrypt/live/ 2>/dev/null
nginx -t 2>&1 | tail -1
systemctl reload nginx
sleep 1
echo -n "[local-https-check] "
curl -sk -m 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" && echo
