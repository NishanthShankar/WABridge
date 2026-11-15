#!/usr/bin/env bash
set -euo pipefail

DOMAIN="wabridge.co.in"
TUNNEL_NAME="wabridge"
SERVER="http://localhost:4000"
# The wabridge tunnel has its own config and launchd job; ~/.cloudflared/config.yml
# belongs to a different tunnel and must not be touched from here.
CLOUDFLARED_CONFIG="$HOME/.cloudflared/wabridge.yml"
TUNNEL_SERVICE="com.cloudflare.tunnel"
# Origin cert scoped to the ${DOMAIN} zone. The default ~/.cloudflared/cert.pem is
# scoped to another zone, so "route dns" with it would create the record there.
CLOUDFLARED_CERT="${CLOUDFLARED_CERT:-$HOME/.cloudflared/cert-wabridge.pem}"
CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/config.yaml"

# Resolve admin API key from config.yaml (or ADMIN_KEY env var override)
if [ -n "${ADMIN_KEY:-}" ]; then
  :
elif [ -f "$CONFIG_FILE" ]; then
  ADMIN_KEY=$(awk '
    /^admin:/ { in_admin=1; next }
    /^[^[:space:]]/ { in_admin=0 }
    in_admin && /^[[:space:]]+api_key:/ {
      sub(/^[^:]+:[[:space:]]*/, "")
      gsub(/^"|"$/, "")
      print; exit
    }
  ' "$CONFIG_FILE")
fi

if [ -z "${ADMIN_KEY:-}" ]; then
  echo "Error: admin API key not found. Set admin.api_key in config.yaml or export ADMIN_KEY." >&2
  exit 1
fi

# --- Usage ---
if [ -z "${1:-}" ]; then
  echo "Usage: $0 <tenant-name>"
  echo "Example: $0 mejobiz"
  exit 1
fi

TENANT="$1"
HOSTNAME="${TENANT}.${DOMAIN}"

echo "==> Creating tenant: ${TENANT}"

# 1. Create tenant via admin API
RESPONSE=$(curl -sf -X POST "${SERVER}/admin/tenants" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${ADMIN_KEY}" \
  -d "{\"name\":\"${TENANT}\"}")

TENANT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
API_KEY=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])")

echo "    Tenant created in WABridge"

# 2. Add DNS route via cloudflared
echo "==> Adding DNS route: ${HOSTNAME}"
DNS_DONE=0
if [ -f "${CLOUDFLARED_CERT}" ]; then
  if cloudflared tunnel --origincert "${CLOUDFLARED_CERT}" route dns "${TUNNEL_NAME}" "${HOSTNAME}" 2>&1; then
    DNS_DONE=1
  fi
else
  echo "    SKIPPED: no ${DOMAIN} origin cert at ${CLOUDFLARED_CERT}"
fi

# 3. Add to the wabridge cloudflared config (before the catch-all rule)
if grep -q "hostname: ${HOSTNAME}" "${CLOUDFLARED_CONFIG}" 2>/dev/null; then
  echo "    Already in ${CLOUDFLARED_CONFIG}, skipping"
else
  echo "==> Updating ${CLOUDFLARED_CONFIG}"
  sed -i.bak "/- service: http_status:404/i\\
  - hostname: ${HOSTNAME}\\
    service: http://localhost:4000
" "${CLOUDFLARED_CONFIG}"
  rm -f "${CLOUDFLARED_CONFIG}.bak"
  echo "    Ingress rule added"
fi

# 4. Restart cloudflared
echo "==> Restarting cloudflared"
cloudflared tunnel --config "${CLOUDFLARED_CONFIG}" ingress validate >/dev/null
# Restart only the wabridge tunnel's launchd job; other tunnels keep running.
launchctl kickstart -k "gui/$(id -u)/${TUNNEL_SERVICE}"
sleep 3

if pgrep -qf "cloudflared.*${CLOUDFLARED_CONFIG}"; then
  echo "    cloudflared restarted"
else
  echo "    WARNING: cloudflared may not have started, check manually"
fi

# 5. Print summary
echo ""
echo "========================================"
echo "  Tenant created successfully!"
echo "========================================"
echo "  Name:     ${TENANT}"
echo "  ID:       ${TENANT_ID}"
echo "  API Key:  ${API_KEY}"
echo "  URL:      https://${HOSTNAME}"
echo "========================================"
if [ "${DNS_DONE}" != "1" ]; then
  TUNNEL_ID=$(awk '/^tunnel:/ {print $2; exit}' "${CLOUDFLARED_CONFIG}")
  echo ""
  echo "  DNS NOT CREATED. Add this record in the ${DOMAIN} zone (Cloudflare dashboard):"
  echo "    CNAME  ${TENANT}  ->  ${TUNNEL_ID}.cfargotunnel.com  (Proxied)"
fi
