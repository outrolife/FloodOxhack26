#!/usr/bin/env bash
# Ship the committed code to a VM and (re)start River Clock there (issue #18).
#
#   deploy/ship.sh root@203.0.113.7                    # plain HTTP on the IP
#   deploy/ship.sh root@203.0.113.7 rc.example.org     # HTTPS (the domain's A record must point at the VM)
#
# The repo is private, so instead of cloning on the VM this streams `git archive HEAD` over SSH:
# no GitHub token ever lands on the server. Only committed files are sent (data/ and models stay
# local; the app runs from the committed web/public/data/ JSON and polls the EA itself).
# Live data lives in a Docker volume, so redeploying keeps it.
set -euo pipefail

HOST="${1:?usage: deploy/ship.sh user@host [domain]}"
SITE_ADDRESS="${2:-:80}"
REMOTE_DIR=/opt/river-clock

cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "note: uncommitted changes are NOT shipped (git archive sends HEAD = $(git rev-parse --short HEAD))" >&2
fi

echo "==> waiting for first-boot setup (Docker) on $HOST"
ssh -o StrictHostKeyChecking=accept-new "$HOST" \
  'for i in $(seq 1 60); do command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && exit 0; sleep 5; done; echo "Docker not installed; see deploy/README.md step 2" >&2; exit 1'

echo "==> copying $(git rev-parse --short HEAD) to $HOST:$REMOTE_DIR"
git archive --format=tar HEAD | ssh "$HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && tar -x -C $REMOTE_DIR"
ssh "$HOST" "printf 'SITE_ADDRESS=%s\n' '$SITE_ADDRESS' > $REMOTE_DIR/deploy/.env"

echo "==> building and starting (first build takes a few minutes)"
ssh "$HOST" "cd $REMOTE_DIR && docker compose -f deploy/compose.yaml up -d --build"

echo "==> health check (app container)"
ssh "$HOST" "cd $REMOTE_DIR && for i in \$(seq 1 30); do docker compose -f deploy/compose.yaml exec -T app python -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read().decode())\" && exit 0; sleep 2; done; exit 1"
if [[ "$SITE_ADDRESS" == ":80" ]]; then
  echo "==> health check (through Caddy on port 80)"
  ssh "$HOST" 'curl -fsS http://127.0.0.1/api/health && echo'
fi

IP="${HOST#*@}"
if [[ "$SITE_ADDRESS" == ":80" ]]; then
  echo "River Clock is up: http://$IP/"
else
  echo "River Clock is up: https://$SITE_ADDRESS/ (certificate may take a minute on first start)"
fi
echo "Live data appears about a minute after start (until then the River tab uses the committed JSON)."
