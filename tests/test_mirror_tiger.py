"""Tests for pipeline/mirror_tiger.py (issue #17).

Unit tests check the SQL text and the row preparation without a database. The integration test runs the
real mirror against Postgres and is skipped unless one is available:
- ``RC_TEST_DATABASE_URL`` points at a scratch Postgres/Timescale (the test works in its own schema,
  ``rc_mirror_test``, and drops it first), or
- ``docker`` is on PATH, in which case a throwaway ``timescale/timescaledb`` container is started.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import time
from datetime import UTC, datetime

import numpy as np
import pandas as pd
import pytest

from pipeline import mirror_tiger as mt

# ---------------------------------------------------------------------------------------------
# Synthetic frames in the agreed hourly.parquet schema (issue #3)
# ---------------------------------------------------------------------------------------------


def hourly_frame(start: str = "2026-10-24T00:00Z", hours: int = 48) -> pd.DataFrame:
    """newbotley level + one rain gauge, across the 25 Oct 2026 clock change (UTC hours, no gaps)."""
    ts = pd.date_range(start, periods=hours, freq="h", tz="UTC")
    rng = np.random.default_rng(17)
    level = pd.DataFrame({
        "gauge": "newbotley", "ts_utc": ts, "kind": "level",
        "level_mean": 1.0 + rng.random(hours) / 10, "rain_mm": np.nan, "filled": False, "flagged": False,
    })
    level["level_max"] = level["level_mean"] + 0.01
    if hours > 6:  # one flagged gap hour and one forward-filled hour
        level.loc[5, ["level_mean", "level_max"]] = np.nan
        level.loc[5, "flagged"] = True
        level.loc[6, "filled"] = True
    rain = pd.DataFrame({
        "gauge": "256230TP", "ts_utc": ts, "kind": "rain", "level_mean": np.nan, "level_max": np.nan,
        "rain_mm": rng.random(hours).round(1), "filled": False, "flagged": False,
    })
    return pd.concat([level, rain], ignore_index=True)[mt.HOURLY_COLUMNS]


# ---------------------------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------------------------


def test_schema_sql_matches_parquet_schema_and_is_idempotent():
    sql = "\n".join(mt.schema_sql())
    assert sql.count("CREATE TABLE IF NOT EXISTS") == 2
    assert "PRIMARY KEY (gauge, ts_utc, source)" in sql
    assert "ts_utc     timestamptz" in sql  # UTC instants, never naive local time
    assert "CHECK (source IN ('history', 'live'))" in sql
    for col in mt.HOURLY_COLUMNS:
        assert f"    {col} " in sql
    assert mt.DB_COLUMNS == ["gauge", "ts_utc", "source", *mt.HOURLY_COLUMNS[2:]]


def test_timescale_sql_hypertable_and_continuous_aggregate():
    hyper, cagg = mt.timescale_sql()
    assert "create_hypertable('readings_hourly', by_range('ts_utc'" in hyper
    assert "if_not_exists => TRUE" in hyper and "migrate_data => TRUE" in hyper
    assert "CREATE MATERIALIZED VIEW IF NOT EXISTS readings_daily" in cagg
    assert "timescaledb.continuous" in cagg and "time_bucket(INTERVAL '1 day', ts_utc)" in cagg
    assert "WITH NO DATA" in cagg
    assert mt.refresh_sql() == "CALL refresh_continuous_aggregate('readings_daily', NULL, NULL)"


def test_plain_view_has_same_columns_as_continuous_aggregate():
    def select_list(sql: str) -> list[str]:
        body = sql.split("SELECT", 1)[1].split("FROM", 1)[0]
        return [line.strip().rstrip(",").split()[-1] for line in body.strip().splitlines()]

    assert select_list(mt.plain_view_sql()[0]) == select_list(mt.timescale_sql()[1])


def test_readings_upsert_only_updates_changed_rows():
    sql = mt.readings_upsert_sql()
    assert "ON CONFLICT (gauge, ts_utc, source) DO UPDATE SET" in sql
    assert "IS DISTINCT FROM" in sql
    for col in mt.VALUE_COLUMNS:
        assert f"{col} = EXCLUDED.{col}" in sql
        assert f"readings_hourly.{col}" in sql
    for col in mt.KEY_COLUMNS:
        assert f"{col} = EXCLUDED.{col}" not in sql  # keys are never rewritten
    assert "FROM readings_stage" in sql
    new = mt.new_keys_sql()
    assert "NOT EXISTS" in new and "t.gauge = s.gauge AND t.ts_utc = s.ts_utc AND t.source = s.source" in new


def test_readings_upsert_skips_identical_rows_before_insert():
    # Unchanged rows must never reach ON CONFLICT: on Timescale that would decompress columnstore chunks.
    sql = mt.readings_upsert_sql()
    insert, conflict = sql.split("ON CONFLICT")
    assert "WHERE NOT EXISTS (SELECT 1 FROM readings_hourly t" in insert
    assert "IS NOT DISTINCT FROM" in insert
    for col in mt.VALUE_COLUMNS:
        assert f"t.{col}" in insert and f"s.{col}" in insert


def test_columnstore_sql():
    first = mt.columnstore_sql(already_enabled=False)
    assert first[0].startswith("ALTER TABLE readings_hourly SET (timescaledb.compress")
    assert "compress_segmentby = 'gauge, source'" in first[0] and "compress_orderby = 'ts_utc'" in first[0]
    assert "add_compression_policy('readings_hourly'" in first[1] and "if_not_exists => TRUE" in first[1]
    assert "compress_chunk(c, if_not_compressed => TRUE)" in first[2] and "show_chunks" in first[2]
    assert mt.columnstore_sql(already_enabled=True) == first[1:]  # never re-ALTER a compressed table


def test_copy_and_stage_sql():
    assert mt.copy_sql() == (
        "COPY readings_stage (gauge, ts_utc, source, kind, level_mean, level_max, rain_mm, filled, flagged) "
        "FROM STDIN"
    )
    create, truncate = mt.stage_sql()
    assert create.startswith("CREATE TEMP TABLE IF NOT EXISTS readings_stage (LIKE readings_hourly")
    assert truncate == "TRUNCATE readings_stage"


def test_gauges_upsert_placeholders_match_columns():
    sql = mt.gauges_upsert_sql()
    assert sql.count("%s") == len(mt.GAUGE_COLUMNS)
    assert "ON CONFLICT (key)" in sql


# ---------------------------------------------------------------------------------------------
# Row preparation
# ---------------------------------------------------------------------------------------------


def test_prepare_frame_shapes_rows():
    df = hourly_frame()
    prep = mt.prepare_frame(df, "history")
    assert list(prep.frame.columns) == mt.DB_COLUMNS
    assert prep.n_rows == len(df) and prep.n_duplicates == 0
    assert (prep.frame["source"] == "history").all()
    assert str(prep.frame["ts_utc"].dt.tz) == "UTC"
    assert prep.gauges == ["256230TP", "newbotley"]
    assert prep.frame["filled"].dtype == bool and prep.frame["flagged"].dtype == bool


def test_prepare_frame_converts_times_to_utc():
    df = hourly_frame(hours=3)
    local = df.copy()
    local["ts_utc"] = local["ts_utc"].dt.tz_convert("Europe/London")
    naive = df.copy()
    naive["ts_utc"] = naive["ts_utc"].dt.tz_localize(None)
    base = mt.prepare_frame(df, "live").frame["ts_utc"]
    pd.testing.assert_series_equal(mt.prepare_frame(local, "live").frame["ts_utc"], base)
    pd.testing.assert_series_equal(mt.prepare_frame(naive, "live").frame["ts_utc"], base)


def test_prepare_frame_drops_duplicates_and_null_keys():
    df = hourly_frame(hours=4)
    dup = df.iloc[[0]].copy()
    dup["level_mean"] = 9.99
    null = df.iloc[[1]].copy()
    null["gauge"] = None
    prep = mt.prepare_frame(pd.concat([df, dup, null], ignore_index=True), "history")
    assert prep.n_duplicates == 1 and prep.n_dropped_null_key == 1
    assert prep.n_rows == len(df)
    assert not prep.frame.duplicated(["gauge", "ts_utc"]).any()
    first = prep.frame[(prep.frame.gauge == "newbotley") & (prep.frame.ts_utc == df.ts_utc[0])]
    assert first["level_mean"].item() == 9.99  # last row wins


def test_prepare_frame_fills_missing_flags():
    df = hourly_frame(hours=2)
    df["filled"] = pd.array([None, True, False, None], dtype="boolean")
    prep = mt.prepare_frame(df, "history")
    assert prep.frame["filled"].tolist().count(True) == 1


@pytest.mark.parametrize("change", ["missing_column", "bad_kind", "bad_source"])
def test_prepare_frame_rejects_bad_input(change):
    df = hourly_frame(hours=2)
    source = "history"
    if change == "missing_column":
        df = df.drop(columns="flagged")
    elif change == "bad_kind":
        df.loc[0, "kind"] = "flow"
    else:
        source = "forecast"
    with pytest.raises(ValueError):
        mt.prepare_frame(df, source)


def test_iter_records_converts_types():
    prep = mt.prepare_frame(hourly_frame(hours=8), "history")
    records = list(mt.iter_records(prep.frame))
    assert len(records) == prep.n_rows
    level = records[prep.frame.index[(prep.frame.gauge == "newbotley")][5]]
    gauge, ts, source, kind, lmean, lmax, rain, filled, flagged = level
    assert (gauge, source, kind) == ("newbotley", "history", "level")
    assert isinstance(ts, datetime) and ts.utcoffset().total_seconds() == 0
    assert lmean is None and lmax is None and rain is None  # NaN -> SQL NULL
    assert flagged is True and type(flagged) is bool and type(filled) is bool
    rain_row = next(r for r in records if r[0] == "256230TP")
    assert rain_row[4] is None and type(rain_row[6]) is float and not math.isnan(rain_row[6])


def test_batches():
    frame = mt.prepare_frame(hourly_frame(hours=10), "live").frame
    sizes = [len(b) for b in mt.batches(frame, 7)]
    assert sizes == [7, 7, 6] and sum(sizes) == len(frame)
    with pytest.raises(ValueError):
        list(mt.batches(frame, 0))


def test_gauge_rows_from_stations_yaml():
    rows = mt.gauge_rows(mt.load_stations())
    by_key = {r[0]: dict(zip(mt.GAUGE_COLUMNS, r, strict=True)) for r in rows}
    assert len(by_key) == len(rows)
    assert all(len(r) == len(mt.GAUGE_COLUMNS) for r in rows)
    assert by_key["newbotley"]["role"] == "target" and by_key["newbotley"]["threshold"] == 2.76
    assert by_key["osney"]["role"] == "live_only"
    assert by_key["256230TP"]["kind"] == "rain"
    assert by_key[mt.RAIN_CATCHMENT]["kind"] == "rain"
    assert {r["kind"] for r in by_key.values()} == {"level", "rain"}


def test_gauge_rows_rejects_duplicate_keys():
    with pytest.raises(ValueError):
        mt.gauge_rows({"gauges": [{"key": "a"}, {"key": "a"}]})


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    (tmp_path / "processed").mkdir()
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(mt.ENV_URL, raising=False)
    # Never pick up a real connection string from <repo>/.env during tests.
    monkeypatch.setattr(mt, "database_url", lambda: None)
    return tmp_path


def test_database_url_prefers_env_then_dotenv(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    monkeypatch.delenv(mt.ENV_URL, raising=False)
    assert mt.database_url(env_file) is None
    env_file.write_text("# comment\nOTHER=1\nexport TIGER_DATABASE_URL='postgres://u:p@h:5432/db?sslmode=require'\n")
    assert mt.database_url(env_file) == "postgres://u:p@h:5432/db?sslmode=require"
    monkeypatch.setenv(mt.ENV_URL, "postgres://from-env")
    assert mt.database_url(env_file) == "postgres://from-env"


def test_dry_run_prints_counts_and_plan_without_connecting(data_dir, monkeypatch, capsys):
    hourly_frame().to_parquet(data_dir / "processed" / "hourly.parquet", index=False)
    hourly_frame(hours=5).to_parquet(data_dir / "processed" / "live_hourly.parquet", index=False)

    def no_connect(url):
        raise AssertionError("dry run must not connect")

    monkeypatch.setattr(mt, "_connect", no_connect)
    assert mt.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "history: 96 rows" in out and "live: 10 rows" in out
    assert "CREATE TABLE IF NOT EXISTS readings_hourly" in out
    assert "create_hypertable" in out and "ON CONFLICT (gauge, ts_utc, source)" in out


def test_since_trims_history(data_dir, capsys):
    hourly_frame().to_parquet(data_dir / "processed" / "hourly.parquet", index=False)
    assert mt.main(["--dry-run", "--hourly", "--since", "2026-10-25"]) == 0
    assert "history: 48 rows" in capsys.readouterr().out  # 24 h x 2 series


def test_dry_run_with_missing_files(data_dir, capsys):
    assert mt.main(["--dry-run", "--live"]) == 0
    out = capsys.readouterr().out
    assert "live:" in out and "not found" in out and "history" not in out.split("-- 1.")[0]


def test_main_without_url_or_data(data_dir):
    assert mt.main(["--hourly"]) == 1  # no parquet yet
    hourly_frame().to_parquet(data_dir / "processed" / "hourly.parquet", index=False)
    assert mt.main(["--hourly"]) == 2  # no TIGER_DATABASE_URL


# ---------------------------------------------------------------------------------------------
# Integration: real Postgres (Timescale if available)
# ---------------------------------------------------------------------------------------------

TEST_SCHEMA = "rc_mirror_test"
needs_postgres = pytest.mark.skipif(
    not (os.environ.get("RC_TEST_DATABASE_URL") or shutil.which("docker")),
    reason="integration: set RC_TEST_DATABASE_URL or install Docker",
)


def _docker_timescale() -> tuple[str, str]:
    """Start a throwaway timescale/timescaledb container. Returns (url, container id)."""
    cid = subprocess.run(
        ["docker", "run", "-d", "--rm", "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=rc",
         "timescale/timescaledb:latest-pg16"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    port = subprocess.run(["docker", "port", cid, "5432"], check=True, capture_output=True, text=True)
    url = f"postgresql://postgres:rc@{port.stdout.strip().splitlines()[0]}/postgres"
    return url, cid


@pytest.fixture(scope="module")
def pg_url():
    psycopg = pytest.importorskip("psycopg", reason="needs the 'mirror' extra (psycopg)")
    url = os.environ.get("RC_TEST_DATABASE_URL")
    cid = None
    if not url:
        if not shutil.which("docker"):
            pytest.skip("integration: set RC_TEST_DATABASE_URL or install Docker")
        try:
            url, cid = _docker_timescale()
        except subprocess.CalledProcessError as exc:
            pytest.skip(f"integration: could not start timescale container ({exc.stderr})")
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                with psycopg.connect(url, autocommit=True) as conn:
                    conn.execute(f"DROP SCHEMA IF EXISTS {TEST_SCHEMA} CASCADE")
                    conn.execute(f"CREATE SCHEMA {TEST_SCHEMA}")
                break
            except psycopg.OperationalError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(1)
        # Everything the mirror creates lands in the test schema, never in public.
        yield psycopg.conninfo.make_conninfo(url, options=f"-c search_path={TEST_SCHEMA},public")
    finally:
        if cid:
            subprocess.run(["docker", "stop", cid], capture_output=True)


@needs_postgres
def test_integration_mirror_is_idempotent(pg_url):
    import psycopg

    history = mt.prepare_frame(hourly_frame(), "history")
    live = mt.prepare_frame(hourly_frame(start="2026-10-25T00:00Z", hours=36), "live")
    gauges = mt.gauge_rows(mt.load_stations())

    first = mt.mirror(pg_url, [history, live], gauges, batch_rows=40)
    assert first["history"] == {"rows": 96, "inserted": 96, "updated": 0, "unchanged": 0}
    assert first["live"]["inserted"] == 72
    assert first["gauges"] == {"inserted": len(gauges), "updated": 0}

    second = mt.mirror(pg_url, [history, live], gauges, batch_rows=40)
    assert second["history"] == {"rows": 96, "inserted": 0, "updated": 0, "unchanged": 96}
    assert second["live"] == {"rows": 72, "inserted": 0, "updated": 0, "unchanged": 72}
    assert second["gauges"] == {"inserted": 0, "updated": 0}

    changed = history.frame.copy()
    changed.loc[changed.index[changed.gauge == "newbotley"][0], "level_mean"] += 0.5
    third = mt.mirror(pg_url, [mt.Prepared("history", changed, len(changed))], gauges)
    assert third["history"]["updated"] == 1 and third["history"]["inserted"] == 0

    with psycopg.connect(pg_url, autocommit=True) as conn:
        n = conn.execute("SELECT count(*) FROM readings_hourly").fetchone()[0]
        assert n == 96 + 72
        # history and live rows for the same hour coexist
        both = conn.execute(
            "SELECT count(*) FROM readings_hourly WHERE gauge = 'newbotley' AND ts_utc = '2026-10-25T06:00Z'"
        ).fetchone()[0]
        assert both == 2
        # NaN arrives as NULL, flags round-trip, times are UTC instants
        row = conn.execute(
            "SELECT level_mean, flagged, ts_utc FROM readings_hourly "
            "WHERE gauge = 'newbotley' AND source = 'history' ORDER BY ts_utc OFFSET 5 LIMIT 1"
        ).fetchone()
        assert row[0] is None and row[1] is True
        assert row[2] == datetime(2026, 10, 24, 5, tzinfo=UTC)
        daily = conn.execute(
            "SELECT day, level_max, n_hours FROM readings_daily "
            "WHERE gauge = 'newbotley' AND source = 'history' ORDER BY day"
        ).fetchall()
        assert [d[2] for d in daily] == [24, 24]  # UTC days, even across the clock change
        assert conn.execute("SELECT threshold FROM gauges WHERE key = 'newbotley'").fetchone()[0] == 2.76
