"""Mirror hourly and live readings into Tiger Data (Timescale / Postgres). Optional, P2 (SPEC §2). Issue #17.

    python -m pipeline.mirror_tiger [--hourly] [--live] [--dry-run]

This is a **one-way mirror**. ``hourly.parquet`` and ``live_hourly.parquet`` stay the source of truth; the
app, the API and the model never read from the database, so the offline demo does not depend on it.

What it does
------------
1. Creates the schema, idempotently (``CREATE ... IF NOT EXISTS``):
   - ``readings_hourly``: the ``hourly.parquet`` columns plus ``source`` (``history`` | ``live``), primary
     key ``(gauge, ts_utc, source)``, so a live hour and a history hour for the same gauge sit side by side.
     ``ts_utc`` is ``timestamptz`` (UTC).
   - ``gauges``: one row per level gauge and rain gauge in ``config/stations.yaml``, plus ``rain_catchment``.
   - If the ``timescaledb`` extension is available, ``readings_hourly`` becomes a **hypertable** on
     ``ts_utc`` and ``readings_daily`` is a **continuous aggregate** (UTC daily max/mean level, rain sum per
     gauge and source). On plain Postgres, ``readings_daily`` is an ordinary view with the same columns.
2. Upserts each file in batches: ``COPY`` into a temp table, then ``INSERT ... ON CONFLICT DO UPDATE``. The
   update only fires when a value actually changed (``IS DISTINCT FROM``), so re-running with the same
   files reports 0 inserted, 0 updated and leaves every row untouched.
3. Refreshes the continuous aggregate (Timescale only).

Live rows accumulate: each ``make live`` covers the last 28 days, and older live hours stay in the table.

Connection: ``TIGER_DATABASE_URL`` (a Postgres URL, e.g. the Tiger Cloud service URL with
``?sslmode=require``), else the same key in the gitignored ``<repo>/.env``. Never commit or log it.
``--dry-run`` prints row counts and the SQL plan without connecting and without needing ``psycopg`` (the
optional extra ``mirror``: ``uv pip install --python .venv/bin/python -r pyproject.toml --extra mirror``).

``<data>`` is ``$RC_DATA_DIR`` if set, else ``<repo>/data``. All times are UTC.
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import sys
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from pipeline.stations import data_root

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
STATIONS_YAML = REPO_ROOT / "config" / "stations.yaml"
ENV_URL = "TIGER_DATABASE_URL"

READINGS_TABLE = "readings_hourly"
STAGE_TABLE = "readings_stage"
GAUGES_TABLE = "gauges"
DAILY_VIEW = "readings_daily"
CHUNK_INTERVAL = "180 days"  # ~40 chunks for 2006-now; live data (28 days) fits in one
BATCH_ROWS = 50_000
RAIN_CATCHMENT = "rain_catchment"

# The agreed hourly.parquet schema (issue #3); live_hourly.parquet uses the same one.
HOURLY_COLUMNS = ["gauge", "ts_utc", "kind", "level_mean", "level_max", "rain_mm", "filled", "flagged"]
KEY_COLUMNS = ["gauge", "ts_utc", "source"]
VALUE_COLUMNS = ["kind", "level_mean", "level_max", "rain_mm", "filled", "flagged"]
DB_COLUMNS = KEY_COLUMNS + VALUE_COLUMNS

GAUGE_KEY = ["key"]
GAUGE_VALUES = [
    "kind", "role", "name", "river", "ref", "rloi_id", "lat", "lon",
    "amber", "threshold", "record", "trace", "fm_measure", "datum_maod",
]
GAUGE_COLUMNS = GAUGE_KEY + GAUGE_VALUES


def database_url(env_file: Path = REPO_ROOT / ".env") -> str | None:
    """``$TIGER_DATABASE_URL``, else the same key from the gitignored ``<repo>/.env``. Never log it."""
    url = os.environ.get(ENV_URL)
    if url or not env_file.exists():
        return url or None
    for line in env_file.read_text().splitlines():
        name, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and name.strip() == ENV_URL:
            return value.strip().strip("'\"") or None
    return None


def source_paths() -> dict[str, Path]:
    """Parquet file for each ``source`` value."""
    processed = data_root() / "processed"
    return {"history": processed / "hourly.parquet", "live": processed / "live_hourly.parquet"}


# ---------------------------------------------------------------------------------------------
# SQL (pure functions, so the tests can check them without a database)
# ---------------------------------------------------------------------------------------------


def schema_sql() -> list[str]:
    """Tables that exist on plain Postgres and on Timescale."""
    return [
        f"""CREATE TABLE IF NOT EXISTS {GAUGES_TABLE} (
    key        text PRIMARY KEY,
    kind       text NOT NULL CHECK (kind IN ('level', 'rain')),
    role       text NOT NULL,
    name       text,
    river      text,
    ref        text,
    rloi_id    text,
    lat        double precision,
    lon        double precision,
    amber      double precision,
    threshold  double precision,
    record     double precision,
    trace      text,
    fm_measure text,
    datum_maod double precision
)""",
        f"""CREATE TABLE IF NOT EXISTS {READINGS_TABLE} (
    gauge      text             NOT NULL,
    ts_utc     timestamptz      NOT NULL,
    source     text             NOT NULL CHECK (source IN ('history', 'live')),
    kind       text             NOT NULL CHECK (kind IN ('level', 'rain')),
    level_mean double precision,
    level_max  double precision,
    rain_mm    double precision,
    filled     boolean          NOT NULL DEFAULT false,
    flagged    boolean          NOT NULL DEFAULT false,
    PRIMARY KEY (gauge, ts_utc, source)
)""",
        f"COMMENT ON TABLE {READINGS_TABLE} IS "
        "'River Clock mirror of hourly.parquet (history) and live_hourly.parquet (live). Stage values are "
        "per-gauge local datums: never compare them across gauges.'",
    ]


def timescale_sql() -> list[str]:
    """Hypertable plus a continuous aggregate. Run only when the timescaledb extension is installed."""
    return [
        f"SELECT create_hypertable('{READINGS_TABLE}', by_range('ts_utc', INTERVAL '{CHUNK_INTERVAL}'), "
        "if_not_exists => TRUE, migrate_data => TRUE)",
        f"""CREATE MATERIALIZED VIEW IF NOT EXISTS {DAILY_VIEW}
WITH (timescaledb.continuous) AS
SELECT gauge,
       source,
       time_bucket(INTERVAL '1 day', ts_utc) AS day,
       max(level_max)     AS level_max,
       avg(level_mean)    AS level_mean,
       sum(rain_mm)       AS rain_mm,
       count(*)           AS n_hours,
       sum(flagged::int)  AS n_flagged
FROM {READINGS_TABLE}
GROUP BY gauge, source, day
WITH NO DATA""",
    ]


def plain_view_sql() -> list[str]:
    """Same columns as the continuous aggregate, as an ordinary view (plain Postgres fallback)."""
    return [
        f"""CREATE OR REPLACE VIEW {DAILY_VIEW} AS
SELECT gauge,
       source,
       date_trunc('day', ts_utc, 'UTC') AS day,
       max(level_max)     AS level_max,
       avg(level_mean)    AS level_mean,
       sum(rain_mm)       AS rain_mm,
       count(*)           AS n_hours,
       sum(flagged::int)  AS n_flagged
FROM {READINGS_TABLE}
GROUP BY gauge, source, 3"""
    ]


def refresh_sql() -> str:
    """Materialise the continuous aggregate. Must run outside a transaction block."""
    return f"CALL refresh_continuous_aggregate('{DAILY_VIEW}', NULL, NULL)"


def stage_sql() -> list[str]:
    """Session temp table with the same columns as the target, emptied before each batch."""
    return [
        f"CREATE TEMP TABLE IF NOT EXISTS {STAGE_TABLE} (LIKE {READINGS_TABLE} INCLUDING DEFAULTS)",
        f"TRUNCATE {STAGE_TABLE}",
    ]


def copy_sql() -> str:
    return f"COPY {STAGE_TABLE} ({', '.join(DB_COLUMNS)}) FROM STDIN"


def upsert_sql(
    target: str, source_sql: str, key: Sequence[str], values: Sequence[str], columns: Sequence[str]
) -> str:
    """``INSERT ... ON CONFLICT DO UPDATE`` that only touches rows whose values changed.

    Rows that are identical are skipped by the ``WHERE``, so they are neither rewritten nor counted: the
    statement's row count is inserted + updated rows only.
    """
    cols = ", ".join(columns)
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in values)
    old = ", ".join(f"{target}.{c}" for c in values)
    new = ", ".join(f"EXCLUDED.{c}" for c in values)
    return (
        f"INSERT INTO {target} ({cols})\n"
        f"{source_sql}\n"
        f"ON CONFLICT ({', '.join(key)}) DO UPDATE SET {sets}\n"
        f"WHERE ({old}) IS DISTINCT FROM ({new})"
    )


def new_keys_sql() -> str:
    """How many staged rows are new (not yet in the target). Run before the upsert to split its count."""
    match = " AND ".join(f"t.{c} = s.{c}" for c in KEY_COLUMNS)
    return (
        f"SELECT count(*) FROM {STAGE_TABLE} s\n"
        f"WHERE NOT EXISTS (SELECT 1 FROM {READINGS_TABLE} t WHERE {match})"
    )


def readings_upsert_sql() -> str:
    return upsert_sql(
        READINGS_TABLE, f"SELECT {', '.join(DB_COLUMNS)} FROM {STAGE_TABLE}", KEY_COLUMNS, VALUE_COLUMNS,
        DB_COLUMNS,
    )


def gauges_upsert_sql() -> str:
    placeholders = ", ".join(["%s"] * len(GAUGE_COLUMNS))
    return upsert_sql(GAUGES_TABLE, f"VALUES ({placeholders})", GAUGE_KEY, GAUGE_VALUES, GAUGE_COLUMNS)


# ---------------------------------------------------------------------------------------------
# Row preparation
# ---------------------------------------------------------------------------------------------


@dataclass
class Prepared:
    source: str
    frame: pd.DataFrame
    n_input: int
    n_duplicates: int = 0
    n_dropped_null_key: int = 0
    gauges: list[str] = field(default_factory=list)

    @property
    def n_rows(self) -> int:
        return len(self.frame)


def prepare_frame(df: pd.DataFrame, source: str) -> Prepared:
    """Validate an hourly frame and shape it as ``DB_COLUMNS``.

    - ``ts_utc`` becomes tz-aware UTC (naive times are taken as UTC, as everywhere in River Clock).
    - rows without a gauge or time are dropped; duplicate ``(gauge, ts_utc)`` keep the last row, since one
      ``INSERT ... ON CONFLICT`` cannot touch the same key twice.
    - ``filled``/``flagged`` missing values become False.
    """
    if source not in ("history", "live"):
        raise ValueError(f"source must be 'history' or 'live', not {source!r}")
    missing = [c for c in HOURLY_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{source}: missing columns {missing}; expected {HOURLY_COLUMNS}")
    out = df[HOURLY_COLUMNS].copy()
    n_input = len(out)
    out["ts_utc"] = pd.to_datetime(out["ts_utc"], utc=True)
    null_key = out["gauge"].isna() | out["ts_utc"].isna()
    out = out[~null_key]
    out["gauge"] = out["gauge"].astype(str)
    out["kind"] = out["kind"].astype(str)
    bad_kind = sorted(set(out["kind"]) - {"level", "rain"})
    if bad_kind:
        raise ValueError(f"{source}: unexpected kind values {bad_kind}")
    for c in ("level_mean", "level_max", "rain_mm"):
        out[c] = pd.to_numeric(out[c], errors="coerce").astype(float)
    for c in ("filled", "flagged"):
        out[c] = out[c].astype("boolean").fillna(False).astype(bool)
    dup = out.duplicated(["gauge", "ts_utc"], keep="last")
    out = out[~dup]
    out.insert(2, "source", source)
    out = out.sort_values(["gauge", "ts_utc"]).reset_index(drop=True)
    return Prepared(
        source=source,
        frame=out[DB_COLUMNS],
        n_input=n_input,
        n_duplicates=int(dup.sum()),
        n_dropped_null_key=int(null_key.sum()),
        gauges=sorted(out["gauge"].unique().tolist()),
    )


def _clean(value: Any) -> Any:
    """NaN -> None (SQL NULL); numpy scalars -> Python; pandas Timestamp -> datetime."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    if hasattr(value, "item"):  # numpy scalar
        return _clean(value.item())
    return value


def iter_records(frame: pd.DataFrame) -> Iterator[tuple[Any, ...]]:
    """Rows of ``frame`` as tuples ready for ``COPY`` (column order = ``DB_COLUMNS``)."""
    for row in frame[DB_COLUMNS].itertuples(index=False, name=None):
        yield tuple(_clean(v) for v in row)


def batches(frame: pd.DataFrame, size: int = BATCH_ROWS) -> Iterator[pd.DataFrame]:
    if size <= 0:
        raise ValueError("batch size must be positive")
    for start in range(0, len(frame), size):
        yield frame.iloc[start : start + size]


def _num(value: Any) -> float | None:
    return None if value is None else float(value)


def gauge_rows(stations: dict[str, Any]) -> list[tuple[Any, ...]]:
    """``gauges`` rows (column order = ``GAUGE_COLUMNS``) from the parsed ``config/stations.yaml``."""
    rows: list[dict[str, Any]] = []
    for g in stations.get("gauges", []):
        rows.append({
            "key": g["key"], "kind": "level", "role": g.get("role", "unknown"), "name": g.get("name"),
            "river": g.get("river"), "ref": g.get("ref"),
            "rloi_id": None if g.get("rloi_id") is None else str(g["rloi_id"]),
            "lat": _num(g.get("lat")), "lon": _num(g.get("lon")), "amber": _num(g.get("amber")),
            "threshold": _num(g.get("threshold")), "record": _num(g.get("record")),
            "trace": g.get("trace"), "fm_measure": g.get("fm_measure"),
            "datum_maod": _num(g.get("datum_maod")),
        })
    for r in stations.get("rain_gauges", []):
        rows.append({
            "key": r["ref"], "kind": "rain", "role": "rain", "name": r.get("name"), "ref": r["ref"],
            "lat": _num(r.get("lat")), "lon": _num(r.get("lon")), "fm_measure": r.get("fm_measure"),
        })
    rows.append({"key": RAIN_CATCHMENT, "kind": "rain", "role": "rain",
                 "name": "Catchment rain (mean of available rain gauges)"})
    seen: set[str] = set()
    out = []
    for row in rows:
        if row["key"] in seen:
            raise ValueError(f"duplicate gauge key {row['key']!r} in stations.yaml")
        seen.add(row["key"])
        out.append(tuple(row.get(c) for c in GAUGE_COLUMNS))
    return out


def load_stations(path: Path = STATIONS_YAML) -> dict[str, Any]:
    with open(path) as f:
        return yaml.safe_load(f)


def load_source(source: str, path: Path, since: pd.Timestamp | None = None) -> Prepared | None:
    """Read and prepare one parquet file; ``since`` keeps only hours at or after it (UTC)."""
    if not path.exists():
        log.warning("%s: %s not found, skipping", source, path)
        return None
    df = pd.read_parquet(path)
    if since is not None:
        df = df[pd.to_datetime(df["ts_utc"], utc=True) >= since]
    return prepare_frame(df, source)


# ---------------------------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------------------------


def describe(prep: Prepared) -> str:
    f = prep.frame
    if f.empty:
        return f"{prep.source}: 0 rows"
    kinds = f["kind"].value_counts().to_dict()
    return (
        f"{prep.source}: {prep.n_rows} rows ({prep.n_input} read, {prep.n_duplicates} duplicate keys and "
        f"{prep.n_dropped_null_key} null keys dropped), {len(prep.gauges)} series, kinds {kinds}, "
        f"{f['ts_utc'].min().isoformat()} to {f['ts_utc'].max().isoformat()}, "
        f"{math.ceil(prep.n_rows / BATCH_ROWS)} batch(es) of <= {BATCH_ROWS}"
    )


def sql_plan(n_gauges: int, sources: Sequence[str]) -> list[str]:
    plan = ["-- 1. schema (idempotent)", *schema_sql(),
            "-- 2a. if the timescaledb extension is available", "CREATE EXTENSION IF NOT EXISTS timescaledb",
            *timescale_sql(), "-- 2b. otherwise (plain Postgres)", *plain_view_sql(),
            f"-- 3. gauges: {n_gauges} rows", gauges_upsert_sql()]
    for s in sources:
        plan += [f"-- 4. {s}: per batch, inside one transaction", *stage_sql(), copy_sql(), new_keys_sql(),
                 readings_upsert_sql()]
    plan += ["-- 5. Timescale only, outside a transaction", refresh_sql()]
    return plan


# ---------------------------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------------------------


def _connect(url: str) -> Any:
    try:
        import psycopg  # optional extra "mirror": keep the import here so nothing else needs it
    except ImportError as exc:
        raise SystemExit(
            "psycopg is not installed: "
            "uv pip install --python .venv/bin/python -r pyproject.toml --extra mirror"
        ) from exc

    return psycopg.connect(url, autocommit=True, application_name="river-clock-mirror")


def has_timescale(conn: Any) -> bool:
    """True if timescaledb is installed, installing it first if the server offers it."""
    installed = conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'").fetchone()
    if installed:
        return True
    available = conn.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'").fetchone()
    if not available:
        return False
    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
        return True
    except Exception as exc:  # e.g. not allowed for this role
        log.warning("timescaledb is available but could not be created (%s); using plain Postgres", exc)
        return False


def ensure_schema(conn: Any) -> bool:
    """Create tables, hypertable and daily view. Returns True if Timescale features are in use."""
    with conn.transaction():
        for stmt in schema_sql():
            conn.execute(stmt)
    timescale = has_timescale(conn)
    # Continuous aggregates cannot be created inside a transaction block, so run these in autocommit.
    for stmt in timescale_sql() if timescale else plain_view_sql():
        conn.execute(stmt)
    return timescale


def upsert_gauges(conn: Any, rows: Sequence[tuple[Any, ...]]) -> tuple[int, int]:
    """Upsert the gauges rows. Returns (inserted, updated)."""
    sql = gauges_upsert_sql()
    with conn.transaction():
        existing = {k for (k,) in conn.execute(f"SELECT key FROM {GAUGES_TABLE}").fetchall()}
        changed = sum(conn.execute(sql, row).rowcount for row in rows)
    inserted = sum(1 for row in rows if row[0] not in existing)
    return inserted, changed - inserted


def upsert_readings(conn: Any, prep: Prepared, batch_rows: int = BATCH_ROWS) -> tuple[int, int]:
    """COPY each batch into the temp table, then merge it into ``readings_hourly`` in one transaction."""
    inserted = updated = 0
    upsert = readings_upsert_sql()
    for n, batch in enumerate(batches(prep.frame, batch_rows), start=1):
        with conn.transaction():
            for stmt in stage_sql():
                conn.execute(stmt)
            with conn.cursor() as cur:
                with cur.copy(copy_sql()) as copy:
                    for record in iter_records(batch):
                        copy.write_row(record)
                (i,) = cur.execute(new_keys_sql()).fetchone()
                u = cur.execute(upsert).rowcount - i  # rowcount = inserted + updated
        inserted, updated = inserted + i, updated + u
        log.info("%s batch %d: %d rows, %d inserted, %d updated", prep.source, n, len(batch), i, u)
    return inserted, updated


def mirror(url: str, preps: Sequence[Prepared], gauges: Sequence[tuple[Any, ...]],
           batch_rows: int = BATCH_ROWS) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    with _connect(url) as conn:
        # Never log the URL or host: the URL holds the password.
        log.info("connected: database %s, server version %s", conn.info.dbname, conn.info.server_version)
        summary["timescale"] = ensure_schema(conn)
        summary["gauges"] = dict(zip(("inserted", "updated"), upsert_gauges(conn, gauges), strict=True))
        for prep in preps:
            i, u = upsert_readings(conn, prep, batch_rows)
            summary[prep.source] = {"rows": prep.n_rows, "inserted": i, "updated": u,
                                    "unchanged": prep.n_rows - i - u}
        if summary["timescale"]:
            conn.execute(refresh_sql())
    return summary


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m pipeline.mirror_tiger", description=__doc__.split("\n")[0])
    p.add_argument("--hourly", action="store_true",
                   help="mirror <data>/processed/hourly.parquet as source=history")
    p.add_argument("--live", action="store_true",
                   help="mirror <data>/processed/live_hourly.parquet as source=live")
    p.add_argument("--dry-run", action="store_true", help="print row counts and the SQL plan; do not connect")
    p.add_argument("--batch-rows", type=int, default=BATCH_ROWS,
                   help=f"rows per COPY batch (default {BATCH_ROWS})")
    p.add_argument("--since", type=lambda v: pd.Timestamp(v, tz="UTC"), default=None, metavar="YYYY-MM-DD",
                   help="only mirror hours from this UTC date on (keeps a free-tier service small)")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = parse_args(argv)
    sources = [s for s, on in (("history", args.hourly), ("live", args.live)) if on] or ["history", "live"]
    paths = source_paths()
    preps = [p for p in (load_source(s, paths[s], args.since) for s in sources) if p is not None]
    gauges = gauge_rows(load_stations())

    if args.dry_run:
        print(f"-- dry run: nothing is sent; would connect with ${ENV_URL}")
        print(f"-- gauges: {len(gauges)} rows from {STATIONS_YAML.relative_to(REPO_ROOT)}")
        for s in sources:
            prep = next((p for p in preps if p.source == s), None)
            print(f"-- {describe(prep) if prep else f'{s}: {paths[s]} not found, skipped'}")
        for stmt in sql_plan(len(gauges), sources):
            print(stmt if stmt.startswith("--") else f"{stmt};\n")
        return 0

    if not preps:
        log.error("nothing to mirror: none of %s exist (run make data / make live first)",
                  [str(paths[s]) for s in sources])
        return 1
    url = database_url()
    if not url:
        log.error("%s is not set, nor in .env (see docs/tiger-data.md); try --dry-run", ENV_URL)
        return 2
    summary = mirror(url, preps, gauges, args.batch_rows)
    log.info("done: %s", summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
