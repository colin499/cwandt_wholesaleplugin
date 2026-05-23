#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# The Shopify CLI bundles a stale cloudflared (2024.8.2) that Cloudflare's edge now rejects
# ("Unauthorized: Tunnel not found"), which kills the tunnel within the hour and hangs the CLI
# at "Preparing dev preview". Point the CLI at the current Homebrew cloudflared instead.
# Falls back to the bundled binary if brew's isn't installed.
export SHOPIFY_CLI_CLOUDFLARED_PATH="$(command -v cloudflared || echo "$SCRIPT_DIR/node_modules/@shopify/cli/bin/cloudflared")"

# Clean up any leftover dev processes from a previous (possibly frozen) session.
pkill -f "shopify app dev" 2>/dev/null || true
pkill -f "cloudflared" 2>/dev/null || true
pkill -f "dev-proxy.mjs" 2>/dev/null || true
sleep 1

# Standard Shopify dev: the CLI manages one tunnel that serves BOTH the embedded app and the
# extensions, and updates the app URLs in the Partner Dashboard automatically
# (automatically_update_urls_on_dev = true). No custom proxy or --tunnel-url needed.
exec npx shopify app dev
