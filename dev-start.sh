#!/bin/bash
set -e

# Kill any leftover dev-proxy or cloudflared processes
pkill -f "dev-proxy.mjs" 2>/dev/null || true
pkill -f "cloudflared.*61801" 2>/dev/null || true

# Start dev proxy
node "$(dirname "$0")/dev-proxy.mjs" &
echo "Dev proxy started on :61801"

# Start cloudflared tunnel to dev proxy (clear old log first)
rm -f /tmp/cf-proxy.log
"$(dirname "$0")/node_modules/@shopify/cli/bin/cloudflared" tunnel \
  --url http://localhost:61801 --no-autoupdate \
  > /tmp/cf-proxy.log 2>&1 &

# Wait for tunnel URL (up to 30s)
echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf-proxy.log | head -1)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Could not get tunnel URL after 30s"
  exit 1
fi

echo ""
echo "Tunnel: $TUNNEL_URL"
echo ""

# Update SHOPIFY_APP_URL in .env so OAuth callback URL is correct
SCRIPT_DIR="$(dirname "$0")"
if grep -q "^SHOPIFY_APP_URL=" "$SCRIPT_DIR/.env"; then
  sed -i '' "s|^SHOPIFY_APP_URL=.*|SHOPIFY_APP_URL=$TUNNEL_URL|" "$SCRIPT_DIR/.env"
else
  echo "SHOPIFY_APP_URL=$TUNNEL_URL" >> "$SCRIPT_DIR/.env"
fi
echo "Set SHOPIFY_APP_URL=$TUNNEL_URL"

# Start Shopify dev with our tunnel (updates Partner Dashboard automatically)
npx shopify app dev --tunnel-url "$TUNNEL_URL:61800" 2>&1 | cat
