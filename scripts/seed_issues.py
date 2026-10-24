#!/usr/bin/env python3
"""Create the GitHub labels and issues for River Clock from SPEC.md §11–§14.

Idempotent: an issue whose title already exists (open or closed) is skipped.
Run once from the repo root:  python3 scripts/seed_issues.py
"""
from __future__ import annotations

import json
import subprocess

LABELS = {
    "data": ("1d76db", "Data lead: pipeline/, config/stations.yaml"),
    "model": ("5319e7", "Model lead: analysis/, model/"),
    "app": ("0e8a16", "App lead: web/, api/"),
    "story": ("fbca04", "Story lead: config/events.yaml, spots.yaml, README, Devpost"),
    "integration": ("bfdadc", "Repo-wide setup and merging"),
    "P0": ("b60205", "Core, must ship"),
    "P1": ("d93f0b", "Core, should ship"),
    "P2": ("e99695", "Core, nice to ship"),
    "stretch": ("c5def5", "SPEC §11, only after the core gate"),
    "in-progress": ("ededed", "Claimed: someone is working on this now"),
}

# (title, labels, body)
ISSUES = [
    ("Repo scaffold: layout, Makefile, pyproject, test setup", ["integration", "P0"],
     "Create the SPEC §2 layout (empty modules are fine), `Makefile` targets, `pyproject.toml` "
     "with the §2 stack, `tests/` with pytest, and ruff config.\n\n**Done when:** `make test` runs on a clean clone."),
    ("First-hour verification checklist", ["data", "P0"],
     "Work through SPEC §14 items 1 to 5. Post results in the team chat and update `config/stations.yaml`.\n\n"
     "Record the datum fields for osney and newbotley too: stretch item S3 depends on them."),
    ("Clean hourly data: osney + upstream gauges + rain", ["data", "P0"],
     "SPEC §5. Ingest history, clean, quality report.\n\n**Done when:** `hourly.parquet` exists and quality.json renders. **Target:** Sat 21:00."),
    ("contracts.ts and fixtures for every §9 contract", ["app", "P0"],
     "Mirror SPEC §9 exactly in `web/src/contracts.ts` and add one valid sample per file in `tests/fixtures/`. "
     "Every other team builds against these, so do it first."),
    ("Scaffold web app with all five tabs on fixture data", ["app", "P0"],
     "SPEC §10.2: React + Vite + TS, Leaflet, Recharts. River, Time Machine, Decide, Proof and About tabs on fixtures. "
     "The disclaimer appears on every screen."),
    ("features.py and leakage test against fixtures", ["model", "P0"],
     "SPEC §7.2. All features known at time t. Add the leakage test in `tests/` (acceptance criterion in §15)."),
    ("Travel-time finding: Thames chain to osney", ["model", "P0"],
     "SPEC §6.\n\n**Done when:** `travel_times.json` renders on Proof. **Target:** Sat 23:00."),
    ("Osney model, all leads, calibrated, plus e2014 replay", ["model", "P0"],
     "SPEC §7.3 to §7.6 and §8.1.\n\n**Done when:** Time Machine plays e2014. **Target:** Sun 02:00."),
    ("River (static) and Time Machine on real data, offline", ["app", "P0"],
     "SPEC §10.2.\n\n**Done when:** the demo runs from committed JSON with no network. **Target:** Sun 03:00."),
    ("Verify spots, events, threshold evidence and warning area codes", ["story", "P0"],
     "SPEC §4.2, §4.3 and §12: spot coordinates, event dates, threshold evidence from news and EA sources, official warning area codes."),
    ("All 5 spots, all events, full proof.json", ["model", "P1"],
     "SPEC §8.2.\n\n**Done when:** metrics render with intervals. **Target:** Sun 06:00."),
    ("Proof tab: metrics, calibration and travel times", ["app", "P1"],
     "SPEC §10.2. Render proof.json with intervals. **Target:** Sun 06:00."),
    ("Official-warning comparison and trade-off curve", ["model", "data", "P1"],
     "SPEC §8.2: hours earlier than EA warnings together with the false-alarm count, as a trade-off curve. "
     "Needs the historic warnings ingest.\n\n**Target:** Sun 07:00."),
    ("Official-warning markers in Time Machine", ["app", "P1"],
     "Show EA warning issue times on the Time Machine timeline. **Target:** Sun 07:00."),
    ("Decide tab: cost-loss trigger and expected-cost chart", ["app", "P2"],
     "SPEC §10.2, computed client-side.\n\n**Done when:** the expected-cost chart works. **Target:** Sun 08:30."),
    ("Live mode: ingest_live, forecast_live, /api/live", ["data", "model", "app", "P2"],
     "SPEC §10.1. Poll EA at most every 15 minutes. **Target:** Sun 09:30."),
    ("Tiger Data mirror of hourly and live readings", ["data", "P2"],
     "SPEC §2: optional mirror for the MLH prize. **Target:** Sun 09:30."),
    ("Vultr deploy", ["app", "P2"], "Host the app on Vultr for the MLH prize. **Target:** Sun 09:30."),
    ("README, Devpost and demo rehearsal", ["story", "P1"],
     "SPEC §17 demo requirements. README lists all data sources and licences. Submit to Devpost by 12:00."),
    ("S1: Official flood-risk map layer", ["stretch", "app", "data"],
     "SPEC §11 S1. Start only after the core gate in §13. Hide it from the UI if unfinished by Sun 09:00."),
    ("S2: Ensemble rainfall context", ["stretch", "app", "data"],
     "SPEC §11 S2. Context only, not a model input. Core gate first."),
    ("S3: Experimental flood-spread ensemble (Osney/Botley)", ["stretch", "model"],
     "SPEC §11 S3. **Blocked unless** the gauge datum in mAOD is verified (see the first-hour checklist). Core gate first."),
    ("S4: Sandbag screening", ["stretch", "model", "app"],
     "SPEC §11 S4. Depends on S3. Screening score only, never instructions."),
]


def gh(*args: str) -> str:
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"gh {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def main() -> None:
    for name, (colour, desc) in LABELS.items():
        gh("label", "create", name, "--color", colour, "--description", desc, "--force")
    existing = {i["title"] for i in json.loads(
        gh("issue", "list", "--state", "all", "--limit", "500", "--json", "title"))}
    for title, labels, body in ISSUES:
        if title in existing:
            print(f"skip   {title}")
            continue
        url = gh("issue", "create", "--title", title, "--body", body,
                 *sum((["--label", l] for l in labels), [])).strip()
        print(f"create {url}  {title}")


if __name__ == "__main__":
    main()
