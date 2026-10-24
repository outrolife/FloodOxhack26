# River Clock: demo plan B (print this page)

Judging: **Sun 25 Oct 2026, after code freeze (11:00)**. The clocks went back at 02:00, so the app shows **GMT (= UTC)**. The main walkthrough is `docs/demo.md`; this page is what to do when something goes wrong. Fill the blanks the night before.

| Role | Name |
|---|---|
| Presenter (drives the laptop) | ____ |
| Carries the charger + spare USB-C cable | ____ |
| Has the phone hotspot ready | ____ |
| Has the Devpost video + screenshots on their phone | ____ |

## Plan A: the laptop, offline (the normal case)

1. **Saturday night, online:** `git pull`, `make setup`, then `make demo` once. That installs everything; after it, nothing needs the network. **Sunday before the freeze, online:** the live owner runs `make live-web` (polls the EA once, writes and validates the file) and commits `web/public/data/live.json`, so the offline Now view shows a real saved forecast instead of the sample (`make preflight` warns while it's missing).
2. **At the table:** laptop on mains, Wi-Fi off, `make demo`. It builds the app only if the sources changed, serves everything from one process at **http://127.0.0.1:8080/** and opens the browser.
3. In a second terminal: `make preflight`. Every line should be ✅ or ℹ️. Fix any ❌ before the first judge. It also prints the UK time and zone (should say GMT on Sunday).
4. Live mode is **off** by default: the Now view (key 1) says "Live data unavailable" and shows the saved forecast. To show today's EA readings (only with good Wi-Fi): `DEMO_LIVE=1 make demo`.
5. The map works offline: it uses a bundled OpenStreetMap basemap (rivers, roads, buildings), so it looks plainer than tiles but has everything. Street tiles are only an optional layer when online.

## Freeze a known-good version

As soon as `make preflight` passes on Sunday morning, tag it and push the tag:

```sh
git tag demo-ready-$(date +%H%M)      # e.g. demo-ready-0945
git push origin --tags
```

## Plan B: the build breaks

| Problem | Fix |
|---|---|
| `make demo` fails after a pull | `git checkout demo-ready-<time>` (latest: `git tag -l 'demo-ready-*'`), then `make demo`. |
| Port 8080 busy | `DEMO_PORT=8090 make demo` and `DEMO_PORT=8090 make preflight`. |
| `npm` or the build fails | `cd web && npm run build`, then `make demo` again. If `web/dist` exists from earlier, `.venv/bin/python scripts/demo_serve.py` serves it without building. |
| Python/uvicorn won't start | `cd web && npm run preview` (built app on :4173; the app falls back to its saved data). Last resort: `npm run dev` (:5173). |
| The app says "sample data" | That view is a test fixture, not results. Say so, or skip it (`make preflight` lists which files are real). |
| Need the internet | Phone hotspot (name/password on a sticky note on the laptop). Only for `DEMO_LIVE=1` or map tiles; the demo doesn't need it. |

## Plan C: the laptop dies

1. Borrow any laptop: the Devpost page has the **video** and **screenshots**; play the video, or open the screenshots full screen.
2. No laptop at all: show the screenshots on a phone and use the 60-second script below.
3. Keep copies of the screenshots and video on **two** phones (they're taken Sunday 09:00–10:30 from the tagged build: 2014 with the scoreboard filled in, Nov 2024, the 2026 near miss, Now).
4. The printed A3 poster on the table tells the whole story with no screen at all: walk the judge through it top to bottom. Source and print steps: `docs/poster/` (`poster.html`, see its `README.md`).

## 60 seconds over the screenshots

<!-- src for every number: docs/demo.md (each has its src comment there). -->

- **2014 (0:00–0:20):** "This is Botley Road in January 2014, replayed hour by hour with only what was known at the time. Noon on 4 January: River Clock says more likely than not. The EA's warning came seven hours later; the river crossed 37 hours after our call."
- **The map (0:20–0:32):** "Oxford floods slowly, from upstream: a rise at Enslow reaches Kings Mill about 19 hours later. Each spot is a clock that fills as the chance of flooding rises, with a countdown. It's a prototype, not an official warning."
- **Nov 2024 (0:32–0:42):** "Here the EA warned about 30 hours before us. We show that too: ahead at Osney and the Cherwell, behind at Botley and Abingdon Road."
- **Proof footer (0:42–0:55):** "At a one-in-two alarm, 30 of 30 floods with 5 false alarms; the EA's warnings, scored the same way, 24 of 30 with 1."
- **Close (0:55–1:00):** "One finding, one model, one baseline, honest proof. Thanks."

Only say numbers that are on the screenshots. If a number isn't there, leave it out.
