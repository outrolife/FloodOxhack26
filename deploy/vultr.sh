#!/usr/bin/env bash
# Create a Vultr Cloud Compute instance for River Clock through the Vultr API v2 (issue #18).
# THIS CREATES A BILLED SERVER. Nothing here runs unless a human runs it with their own key.
#
#   export VULTR_API_KEY=...            # Vultr dashboard > Account > API (allow your IP in its access control)
#   deploy/vultr.sh                     # prints the IP when the server is up
#   deploy/ship.sh root@<IP>            # then build and start the app on it
#
# Optional settings (env):
#   VULTR_REGION      default lhr (London)
#   VULTR_PLAN        default vc2-1c-2gb (1 vCPU, 2 GB, $10/month, $0.014/hour as listed by the API)
#   VULTR_OS_ID       default 2284 (Ubuntu 24.04 LTS x64)
#   VULTR_SSH_KEY_ID  an SSH key already in your Vultr account; otherwise SSH_PUBKEY is uploaded
#   SSH_PUBKEY        default ~/.ssh/id_ed25519.pub
# Needs curl and python3 (for JSON). The key is read from the environment only, never written anywhere.
set -euo pipefail

: "${VULTR_API_KEY:?set VULTR_API_KEY (Vultr dashboard > Account > API)}"
REGION="${VULTR_REGION:-lhr}"
PLAN="${VULTR_PLAN:-vc2-1c-2gb}"
OS_ID="${VULTR_OS_ID:-2284}"
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
API="${VULTR_API_URL:-https://api.vultr.com/v2}"  # override only to test against a mock
HERE="$(cd "$(dirname "$0")" && pwd)"

api() {  # api METHOD PATH [JSON]
  curl -fsS -X "$1" "$API$2" \
    -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
    ${3:+--data "$3"}
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

if [[ -z "${VULTR_SSH_KEY_ID:-}" ]]; then
  [[ -f "$SSH_PUBKEY" ]] || { echo "no SSH key: set VULTR_SSH_KEY_ID or SSH_PUBKEY (ssh-keygen -t ed25519)" >&2; exit 1; }
  echo "==> uploading SSH key $SSH_PUBKEY"
  body=$(python3 -c 'import json,sys; print(json.dumps({"name": "river-clock", "ssh_key": open(sys.argv[1]).read().strip()}))' "$SSH_PUBKEY")
  VULTR_SSH_KEY_ID=$(api POST /ssh-keys "$body" | json 'd["ssh_key"]["id"]')
fi

echo "==> creating $PLAN in $REGION (Ubuntu, os_id $OS_ID)"
body=$(python3 - "$HERE/cloud-init.yaml" "$REGION" "$PLAN" "$OS_ID" "$VULTR_SSH_KEY_ID" <<'PY'
import base64, json, sys
user_data, region, plan, os_id, key = sys.argv[1:]
print(json.dumps({
    "region": region, "plan": plan, "os_id": int(os_id),
    "label": "river-clock", "hostname": "river-clock", "tags": ["oxhack26"],
    "sshkey_id": [key], "backups": "disabled",
    "user_data": base64.b64encode(open(user_data, "rb").read()).decode(),
}))
PY
)
ID=$(api POST /instances "$body" | json 'd["instance"]["id"]')
echo "    instance $ID"

echo "==> waiting for it to boot"
for _ in $(seq 1 60); do
  read -r STATUS IP < <(api GET "/instances/$ID" | json 'd["instance"]["status"] + " " + d["instance"]["main_ip"]')
  [[ "$STATUS" == "active" && "$IP" != "0.0.0.0" ]] && break
  sleep 10
done
[[ "$STATUS" == "active" ]] || { echo "instance $ID not active yet (status $STATUS); check the dashboard" >&2; exit 1; }

echo
echo "Server up: $IP (instance $ID). First-boot setup installs Docker in ~2 minutes; then run:"
echo "  deploy/ship.sh root@$IP"
echo "Delete it after the hackathon to stop billing:"
echo "  curl -X DELETE -H \"Authorization: Bearer \$VULTR_API_KEY\" $API/instances/$ID"
