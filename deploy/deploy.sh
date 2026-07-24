#!/usr/bin/env bash
# Build the Cowl app to static files and push them to the relayer VPS.
#
# Run from the app/ directory on a machine that has SSH access to the VPS:
#
#     ./deploy/deploy.sh root@52.0.240.86
#
# Prerequisites (one-time on the VPS): see deploy/README.md — create the web root
# and add the app.cowlprotocol.com block to /etc/caddy/Caddyfile.
#
# The build reads NEXT_PUBLIC_WC_PROJECT_ID from .env.local (WalletConnect id).
set -euo pipefail

SSH_TARGET="${1:?usage: ./deploy/deploy.sh <user@host>  (e.g. root@52.0.240.86)}"
REMOTE_ROOT="${REMOTE_ROOT:-/var/www/app.cowlprotocol.com}"

cd "$(dirname "$0")/.."

echo "› Building static export…"
npm run build            # output: 'export' → ./out

echo "› Syncing ./out → ${SSH_TARGET}:${REMOTE_ROOT}"
rsync -az --delete out/ "${SSH_TARGET}:${REMOTE_ROOT}/"

echo "› Reloading Caddy on the VPS"
ssh "${SSH_TARGET}" 'sudo systemctl reload caddy || sudo caddy reload --config /etc/caddy/Caddyfile'

echo "✓ Deployed. https://app.cowlprotocol.com"
