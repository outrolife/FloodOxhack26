# River Clock: demo plan B (print this page)

Judging: **Sun 25 Oct 2026, after code freeze (11:00)**. The clocks went back at 02:00, so the app shows **GMT (= UTC)**. The main walkthrough is `docs/demo.md`; this page is what to do when something goes wrong. Fill the blanks the night before.

| Role | Name |
|---|---|
| Presenter (drives the laptop) | ____ |
| Carries the charger + spare USB-C cable | ____ |
| Has the phone hotspot ready | ____ |
| Has the Devpost video + screenshots on their phone | ____ |

## Plan A: the laptop, offline (the normal case)

1. **Saturday night, online:** `git pull`, `make setup`, then `make demo` once. That installs everything; after it, nothing needs the network. **Sunday before the freeze, online:** the live owner runs `make live-web` (polls the EA once, writes and validates the file) and commits `web/public/data/live.json`, so the offline River tab shows a real saved forecast instead of the sample (`make preflight` warns while it's missing).
2. **At the table:** laptop on mains, Wi-Fi off, `make demo`. It builds the app only if the sources changed, serves everything from one process at **http://127.0.0.1:8080/** and opens the browser.
3. In a second terminal: `make preflight`. Every line should be ✅ or ℹ️. Fix any ❌ before the first judge. It also prints the UK time and zone (should say GMT on Sunday).
4. Live mode is **off** by default: the River tab says "Live data unavailable" and shows the saved forecast. To show today's EA readings (only with good Wi-Fi): `DEMO_LIVE=1 make demo`.
5. The map's street tiles need the internet. Offline the map is grey with a note ("Map tiles unavailable offline"); the spot and gauge markers still show. Say: "the map tiles need the internet; the spots and gauges are all still here."

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
| A tab says "sample data" | That tab is a test fixture, not results. Say so, or skip it (`make preflight` lists which files are real). |
| Need the internet | Phone hotspot (name/password on a sticky note on the laptop). Only for `DEMO_LIVE=1` or map tiles; the demo doesn't need it. |

## Plan C: the laptop dies

1. Borrow any laptop: the Devpost page has the **video** and **screenshots**; play the video, or open the screenshots full screen.
2. No laptop at all: show the screenshots on a phone and use the 60-second script below.
3. Keep copies of the screenshots and video on **two** phones (they're taken Sunday 09:00–10:30 from the tagged build: River, Time Machine paused at the 50% marker, Decide, Proof, About).
4. The printed A3 poster on the table tells the whole story with no screen at all: walk the judge through it top to bottom. Source and print steps: `docs/poster/` (`poster.html`, see its `README.md`).

## 60 seconds over the screenshots

- **River (0:00–0:12):** "Oxford floods from the river, slowly. The water that floods Botley Road on Thursday is usually already in the Thames at Farmoor on Tuesday. River Clock reads the upstream gauges like a clock and gives each of five Oxford spots a chance of flooding and a time, up to 72 hours ahead. It's a prototype, not an official warning; the banner says so on every screen."
- **Time Machine (0:12–0:30):** "This is the January 2014 flood replayed hour by hour, with the model only seeing what was known at the time. The fan is the forecast range. Here is where we first said 50%, and here is when the Environment Agency issued its warning."
- **Decide (0:30–0:42):** "A forecast only helps if it changes what you do. If acting costs C and being caught out costs L, act once the chance is above C over L. Moving your car: act at 1%. Closing a road: 5%. The bars compare the cost of following River Clock, the official warnings, never acting and always acting over past floods."
- **Proof (0:42–0:55):** "This is the honest test: skill against 'the level stays where it is', and whether our 30% means 30%. Where we don't beat the baseline, the app says so. Last winter's near miss is our false-alarm test."
- **Close (0:55–1:00):** "One finding, one model, honest proof, and a decision rule. Thanks."

Only say numbers that are on the screenshots. If a number isn't there, leave it out.
