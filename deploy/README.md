# Deploying River Clock on Vultr

One container serves everything from one uvicorn process on port 8000: the built web app at `/`
(unknown page paths fall back to `index.html`), the committed JSON at `/data/*.json`, and the API at
`/api/*`. Caddy sits in front on port 80 (and 443 for HTTPS). A background thread polls the EA every
15 minutes for `/api/live`. If live data fails, the app still works from the committed JSON.

| File | What it is |
|---|---|
| `Dockerfile` | Multi-stage: Node 24 builds `web/dist`, then Python 3.11 slim runs `api.main:app` |
| `compose.yaml` | `app` (the image) + `caddy` (reverse proxy, automatic HTTPS) + volumes |
| `Caddyfile` | `SITE_ADDRESS` = `:80` (plain HTTP on the IP) or a domain (HTTPS) |
| `cloud-init.yaml` | First boot: Docker, 2 GB swap, ufw opens 80/443 |
| `vultr.sh` | Optional: creates the server through the Vultr API (`VULTR_API_KEY`) |
| `ship.sh` | Copies the committed code to the server over SSH, builds, starts, health-checks |

**Time:** about 10 minutes, most of it the first image build on the server (3 to 5 min).
**Cost:** plan `vc2-1c-2gb` (Cloud Compute, Regular Performance: 1 vCPU, 2 GB RAM, 55 GB SSD, 2 TB
transfer) is **$10/month, billed at $0.014/hour** as Vultr's API lists it (24 Oct 2026). Running it
for the weekend costs well under $1. The $5/month `vc2-1c-1gb` also works thanks to the swap from
cloud-init, but builds more slowly. Delete the server afterwards (step 6).

---

## Option A: click through the Vultr dashboard

### 1. Create the server
1. Sign in at my.vultr.com (the MLH prize may come with credit; check the sponsor page).
2. Add your SSH key first: **Account > SSH Keys > Add SSH Key**, paste `~/.ssh/id_ed25519.pub`
   (make one with `ssh-keygen -t ed25519` if needed).
3. **Deploy > Deploy New Server**:
   - Type: **Cloud Compute (Shared CPU)**, **Regular Performance**
   - Location: **London**
   - Image: **Ubuntu 24.04 LTS x64**
   - Plan: **1 vCPU / 2 GB ($10/mo)** (`vc2-1c-2gb`)
   - SSH Keys: tick yours
   - Additional features: turn off Auto Backups (not needed; it adds cost)
   - **Cloud-Init User-Data**: paste the contents of `deploy/cloud-init.yaml`
   - Hostname/label: `river-clock`
4. **Deploy**. Wait until it shows *Running* and note the IP (e.g. `203.0.113.7`).

If you didn't paste the cloud-init, SSH in and run its steps by hand:
```bash
ssh root@203.0.113.7
curl -fsSL https://get.docker.com | sh
ufw allow 80/tcp && ufw allow 443/tcp
```

### 2. Ship and start the app (from your laptop, in the repo)
```bash
git checkout main && git pull           # ship.sh sends the committed HEAD only
deploy/ship.sh root@203.0.113.7
```
It waits for Docker, streams `git archive HEAD` to `/opt/river-clock` (no GitHub token on the server,
which matters because the repo is private), runs `docker compose up -d --build`, and checks
`/api/health`. Then open **http://203.0.113.7/**.

### 3. HTTPS with a domain (optional)
1. Create an `A` record for e.g. `rc.example.org` pointing at the server IP. Wait until
   `dig +short rc.example.org` shows it.
2. `deploy/ship.sh root@203.0.113.7 rc.example.org`
3. Caddy gets a Let's Encrypt certificate on first request: **https://rc.example.org/**.

With a domain set, Caddy answers only that name (and redirects its HTTP to HTTPS). Run `ship.sh`
without the domain to go back to the plain IP.

## Option B: script it with the Vultr API
```bash
export VULTR_API_KEY=...        # my.vultr.com > Account > API; add your IP to its access control
deploy/vultr.sh                 # creates vc2-1c-2gb in London with cloud-init; prints the IP
deploy/ship.sh root@<IP>        # wait ~2 min for cloud-init, then this
```
`VULTR_REGION`, `VULTR_PLAN`, `VULTR_OS_ID` and `VULTR_SSH_KEY_ID` override the defaults; without
`VULTR_SSH_KEY_ID` it uploads `~/.ssh/id_ed25519.pub`. The key is read from the environment only;
never put it in a file in the repo.

---

## 4. Check it
```bash
curl -s http://<IP>/api/health                 # {"status":"ok"}
curl -sI http://<IP>/                          # 200, text/html
curl -s http://<IP>/data/stations.json | head  # committed JSON (404 if not committed yet: the app then
                                               # uses the fixtures bundled into the build)
curl -s http://<IP>/api/live | head -c 300     # 503 "Live data unavailable" for ~1 min after start,
                                               # then the live Forecast
```
Logs: `ssh root@<IP> 'cd /opt/river-clock && docker compose -f deploy/compose.yaml logs -f app'`.

## 5. Update after new merges
Pull `main` and run `deploy/ship.sh root@<IP>` again. Live data survives (it lives in the
`rc-data` volume). Re-run after every `make backtest` that changes `web/public/data/`.

Optional, the trained model for live mode: without models in the volume, `/api/live` uses the
labelled persistence fallback (`model/forecast_live.py`). To use the trained models:
```bash
scp -r data/models root@<IP>:/tmp/models
ssh root@<IP> 'cd /opt/river-clock && docker compose -f deploy/compose.yaml cp /tmp/models app:/data/models \
  && docker compose -f deploy/compose.yaml restart app'
```

To stop polling the EA (serve only the last live data): `RIVER_CLOCK_LIVE_FETCH=0` in
`/opt/river-clock/deploy/.env`, then `docker compose -f deploy/compose.yaml up -d`.

## 6. Tear down (stops billing)
Dashboard: server > **Server Destroy**. Or
`curl -X DELETE -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/instances/<id>`.
A stopped server is still billed; only destroying it stops the charge.

---

## Running the same thing locally
- With Docker: `make docker` then
  `docker run --rm -p 8000:8000 -v river-clock-data:/data river-clock` and open http://localhost:8000/.
  Or the full stack with Caddy: `docker compose -f deploy/compose.yaml up --build`, then http://localhost/.
- Without Docker: `make serve` builds `web/dist` and runs uvicorn with `RIVER_CLOCK_STATIC_DIR=web/dist`
  on http://localhost:8000/ (add `RIVER_CLOCK_LIVE_BACKGROUND=1` for the container's live refresher).

Settings (env), all read by `api/main.py` or the pipeline:

| Variable | Container default | Meaning |
|---|---|---|
| `RIVER_CLOCK_STATIC_DIR` | `/app/web/dist` | Serve this built web app at `/`. Unset: API only (dev) |
| `RIVER_CLOCK_LIVE_BACKGROUND` | `1` | Refresh `/api/live` in a background thread every 15 min |
| `RIVER_CLOCK_LIVE_FETCH` | `1` | `0` = never poll the EA; use the last processed live data |
| `RC_DATA_DIR` | `/data` (volume) | Live readings, EA response cache, optional `models/` |

Every screen keeps the disclaimer: decision-support prototype, not an official warning;
gov.uk/check-flooding.
