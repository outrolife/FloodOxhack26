# Tiger Data mirror (optional, P2)

FloodClock can copy its hourly river and rain readings into a [Tiger Data](https://www.tigerdata.com/)
(Timescale / Postgres) service, so they can be queried with SQL. Issue #17, SPEC §2.

**It is a one-way mirror.** `hourly.parquet` and `live_hourly.parquet` stay the source of truth. The app,
the API and the model never read from the database, so the offline demo works without it.

```
data/processed/hourly.parquet       --(source = 'history')--+
                                                            +-->  readings_hourly (hypertable)
data/processed/live_hourly.parquet  --(source = 'live')-----+           |
config/stations.yaml  ------------------------------------------>  gauges    readings_daily (continuous aggregate)
```

## What gets created

| Object | What it is |
|---|---|
| `readings_hourly` | The `hourly.parquet` columns (`gauge, ts_utc, kind, level_mean, level_max, rain_mm, filled, flagged`) plus `source` (`history` or `live`). Primary key `(gauge, ts_utc, source)`. `ts_utc` is `timestamptz` (UTC). A **hypertable** on `ts_utc` (180-day chunks) when Timescale is present. |
| `gauges` | One row per gauge in `config/stations.yaml` (key, role, name, river, `amber` = top of normal range, `threshold`, `record`, ...), the 5 rain gauges and `rain_catchment`. |
| `readings_daily` | Daily (UTC) max and mean level, rain total, hours and flagged hours per gauge and source. A **continuous aggregate** on Timescale, refreshed after every run; an ordinary view on plain Postgres. |

Stage values use each gauge's own local datum. **Never compare raw levels across gauges**: compare each
gauge with its own `amber` or `threshold` instead, as the queries below do.

## 1. Create a Tiger Cloud service

1. Sign up at <https://console.cloud.tigerdata.com/>. Every plan includes **two free services** (in beta when
   this was written: shared CPU, **750 MiB storage** each; a free service turns read-only when full). The
   Performance plan's 30-day trial needs no credit card.
2. Click **New service**, choose a free service (or the smallest one) and a region near you (London or
   Ireland), and create it. It is ready in a few seconds, with Postgres and the `timescaledb` extension
   already installed.
3. **Download the config** when offered. It holds the connection string, and it is the only time you can
   see the password.

## 2. Set `TIGER_DATABASE_URL`

Put the service URL in the gitignored `.env` at the repo root (the mirror reads it if the variable is not
already set), or export it in your shell:

```bash
echo 'TIGER_DATABASE_URL=postgres://tsdbadmin:<password>@<host>:<port>/tsdb?sslmode=require' >> .env
```

Never commit it, paste it into an issue or PR, or print it in logs. The mirror logs only the database
name and server version.

## 3. Run the mirror

```bash
uv pip install --python .venv/bin/python -r pyproject.toml --extra mirror   # psycopg, once
make data          # or: make fetch-data   (writes data/processed/hourly.parquet)
make live          # writes data/processed/live_hourly.parquet
make mirror        # = python -m pipeline.mirror_tiger --hourly --live
```

Options:

- `--hourly` / `--live`: mirror just one file (no flag means both). A missing file is skipped with a warning.
- `--dry-run`: print the row counts and every SQL statement, without connecting (no psycopg needed).
- `--since 2012-01-01`: only mirror hours from that UTC date on, to keep a small service smaller.
- `--columnstore`: Timescale only. Compresses chunks older than 60 days (segment by `gauge, source`, order
  by `ts_utc`) and adds a compression policy. Run it once, after the history load.

**How the upsert works.** Each batch of 50,000 rows is `COPY`ed into a temp table. Rows identical to what
is already stored are filtered out (a read-only anti-join), and the rest go in with
`INSERT ... ON CONFLICT (gauge, ts_utc, source) DO UPDATE`. Re-running with the same files reports
`0 inserted, 0 updated` and writes nothing. Live rows accumulate: each `make live` covers the last 28 days,
and older live hours stay in the table.

### Measured on the team's service (Sat 24 Oct 2026)

PostgreSQL 18.6, timescaledb 2.31. Data: `hourly.parquet` from release `data-hourly-v1` (3,287,615 rows, 21
series, 2006-01-01 to 2026-10-24 15:00Z) and a live pull (11,848 rows, 12 gauges plus rain).

| Run | Result | Time |
|---|---|---|
| First load, `--hourly --live` | history 3,287,615 inserted, live 11,848 inserted, gauges 18 inserted; 43 chunks; 450 MB | 65 s |
| Re-run, same files | 0 inserted, 0 updated (all 3,299,463 unchanged) | 54 s |
| `--live --columnstore` | 41 of 43 chunks compressed: **434 MB -> 35 MB (12.4x)**; hypertable 48 MB, database 85 MB | 5 s |
| Re-run on compressed data | 0 inserted, 0 updated; size unchanged (48 MB) | 6.3 min |

A re-run against compressed chunks is slower because finding "what changed" has to read compressed
segments. `--live` runs stay fast, because the last 28 days sit in uncompressed chunks. If `hourly.parquet`
changes a lot (for example after a cleaning change), re-run with `--hourly --columnstore` and then
`VACUUM FULL readings_hourly;` to give the space back.

## 4. Queries worth showing judges

Run these in the Tiger Console SQL editor or with `psql "$TIGER_DATABASE_URL"`. The outputs below come from
the team's service on 24 Oct 2026.

### a. New Botley during the January 2014 flood (continuous aggregate)

Daily maximum level against the "property flooding possible" threshold (2.76 m), read from the
`readings_daily` continuous aggregate rather than scanning 3.3 M hourly rows.

```sql
SELECT d.day::date AS day_utc,
       round(d.level_max::numeric, 3) AS daily_max_m,
       g.threshold                    AS threshold_m,
       d.level_max > g.threshold      AS above_threshold
FROM readings_daily d
JOIN gauges g ON g.key = d.gauge
WHERE d.gauge = 'newbotley' AND d.source = 'history'
  AND d.day >= '2014-01-01' AND d.day < '2014-01-15'
ORDER BY d.day;
```

```
day_utc    | daily_max_m | threshold_m | above_threshold
-----------+-------------+-------------+----------------
2014-01-01 | 2.402       | 2.76        | False
2014-01-02 | 2.442       | 2.76        | False
2014-01-03 | 2.549       | 2.76        | False
2014-01-04 | 2.630       | 2.76        | False
2014-01-05 | 2.745       | 2.76        | False
2014-01-06 | 2.884       | 2.76        | True
2014-01-07 | 2.965       | 2.76        | True
2014-01-08 | 3.018       | 2.76        | True
2014-01-09 | 3.032       | 2.76        | True
2014-01-10 | 2.999       | 2.76        | True
2014-01-11 | 2.926       | 2.76        | True
2014-01-12 | 2.844       | 2.76        | True
2014-01-13 | 2.733       | 2.76        | False
2014-01-14 | 2.652       | 2.76        | False
```

Seven days above the threshold, peaking at 3.032 m on 9 Jan (the gauge's `highestRecent`).

### b. Upstream peaks arrive before the target's (the travel-time idea in one query)

When each gauge on New Botley's flow path peaked in the same window, and how many hours earlier than New
Botley.

```sql
SELECT p.gauge, g.role, p.peak_at, round(p.peak_m::numeric, 3) AS peak_m,
       round(extract(epoch FROM (n.peak_at - p.peak_at)) / 3600) AS hours_before_newbotley
FROM (
  SELECT DISTINCT ON (gauge) gauge, ts_utc AS peak_at, level_max AS peak_m
  FROM readings_hourly
  WHERE source = 'history' AND kind = 'level'
    AND gauge IN ('farmoor', 'eynsham', 'cassington', 'newbotley')
    AND ts_utc >= '2014-01-01' AND ts_utc < '2014-01-15'
  ORDER BY gauge, level_max DESC NULLS LAST, ts_utc
) p
JOIN gauges g ON g.key = p.gauge
CROSS JOIN (
  SELECT ts_utc AS peak_at FROM readings_hourly
  WHERE gauge = 'newbotley' AND source = 'history' AND ts_utc >= '2014-01-01' AND ts_utc < '2014-01-15'
  ORDER BY level_max DESC NULLS LAST, ts_utc LIMIT 1
) n
ORDER BY p.peak_at;
```

```
gauge      | role     | peak_at                | peak_m | hours_before_newbotley
-----------+----------+------------------------+--------+-----------------------
cassington | upstream | 2014-01-05 21:00+00:00 | 0.977  | 84
farmoor    | upstream | 2014-01-08 05:00+00:00 | 1.831  | 28
eynsham    | upstream | 2014-01-09 00:00+00:00 | 1.047  | 9
newbotley  | target   | 2014-01-09 09:00+00:00 | 3.032  | 0
```

The Evenlode (Cassington) peaked three and a half days before New Botley, and the Thames at Farmoor more
than a day before. That lead is what FloodClock's forecast is built on (the travel-time analysis, SPEC §6,
does this properly with cross-correlation over all events).

### c. Upstream vs target over a window, each against its own normal (time_bucket)

12-hour means of each gauge's level minus its own top of normal range (`amber`), so gauges with different
datums can sit side by side, plus catchment rain.

```sql
SELECT time_bucket(INTERVAL '12 hours', r.ts_utc) AS bucket_utc,
       round(avg(r.level_mean - g.amber) FILTER (WHERE r.gauge = 'farmoor')::numeric, 2)    AS farmoor,
       round(avg(r.level_mean - g.amber) FILTER (WHERE r.gauge = 'cassington')::numeric, 2) AS cassington,
       round(avg(r.level_mean - g.amber) FILTER (WHERE r.gauge = 'newbotley')::numeric, 2)  AS newbotley,
       round(sum(r.rain_mm) FILTER (WHERE r.gauge = 'rain_catchment')::numeric, 1)          AS rain_mm
FROM readings_hourly r
JOIN gauges g ON g.key = r.gauge
WHERE r.source = 'history'
  AND r.gauge IN ('farmoor', 'cassington', 'newbotley', 'rain_catchment')
  AND r.ts_utc >= '2014-01-02' AND r.ts_utc < '2014-01-10'
GROUP BY bucket_utc
ORDER BY bucket_utc;
```

```
bucket_utc             | farmoor | cassington | newbotley | rain_mm
-----------------------+---------+------------+-----------+--------
2014-01-02 00:00+00:00 | 0.04    | 0.05       | 0.40      | 0.0
2014-01-02 12:00+00:00 | 0.09    | 0.07       | 0.42      | 0.8
2014-01-03 00:00+00:00 | 0.11    | 0.11       | 0.45      | 5.4
2014-01-03 12:00+00:00 | 0.14    | 0.14       | 0.50      | 0.8
2014-01-04 00:00+00:00 | 0.18    | 0.12       | 0.57      | 12.5
2014-01-04 12:00+00:00 | 0.26    | 0.12       | 0.61      | 2.8
2014-01-05 00:00+00:00 | 0.31    | 0.13       | 0.64      | 0.1
2014-01-05 12:00+00:00 | 0.35    | 0.19       | 0.68      | 3.9
2014-01-06 00:00+00:00 | 0.38    | 0.18       | 0.80      | 2.6
2014-01-06 12:00+00:00 | 0.42    | 0.15       | 0.86      | 4.4
2014-01-07 00:00+00:00 | 0.46    | 0.15       | 0.88      | 8.4
2014-01-07 12:00+00:00 | 0.51    | 0.15       | 0.92      | 0.0
2014-01-08 00:00+00:00 | 0.53    | 0.15       | 0.96      | 0.0
2014-01-08 12:00+00:00 | 0.53    | 0.16       | 0.99      | 3.6
2014-01-09 00:00+00:00 | 0.53    | 0.15       | 1.01      | 1.8
2014-01-09 12:00+00:00 | 0.52    | 0.13       | 1.00      | 0.0
```

### d. Right now: latest live reading per gauge against its normal range

```sql
SELECT DISTINCT ON (r.gauge) r.gauge, g.role, r.ts_utc AS latest_hour_utc,
       round(r.level_mean::numeric, 3) AS level_m, g.amber AS top_of_normal_m, g.threshold AS threshold_m,
       round((r.level_mean - g.amber)::numeric, 3) AS vs_normal_m
FROM readings_hourly r
JOIN gauges g ON g.key = r.gauge
WHERE r.source = 'live' AND r.kind = 'level' AND r.level_mean IS NOT NULL
ORDER BY r.gauge, r.ts_utc DESC;
```

```
gauge       | role      | latest_hour_utc        | level_m | top_of_normal_m | threshold_m | vs_normal_m
------------+-----------+------------------------+---------+-----------------+-------------+------------
cassington  | upstream  | 2026-10-24 16:00+00:00 | 0.199   | 0.77            |             | -0.571
coldharbour | target    | 2026-10-24 16:00+00:00 | 0.882   | 2.3             | 2.44        | -1.419
enslow      | upstream  | 2026-10-24 16:00+00:00 | 0.258   | 1.29            |             | -1.033
eynsham     | upstream  | 2026-10-24 16:00+00:00 | -0.095  | 0.37            |             | -0.465
farmoor     | upstream  | 2026-10-24 16:00+00:00 | 0.690   | 1.3             | 1.75        | -0.611
godstow     | live_only | 2026-10-24 16:00+00:00 | 1.644   | 2.57            | 3.07        | -0.927
iffley      | live_only | 2026-10-24 16:00+00:00 | 2.299   | 2.72            | 3.25        | -0.422
islip       | upstream  | 2026-10-24 16:00+00:00 | 6.809   | 7.8             | 8.85        | -0.991
kingsmill   | target    | 2026-10-13 14:00+00:00 | 1.590   | 2.4             | 2.6         | -0.810
minns       | target    | 2026-10-24 16:00+00:00 | 1.218   | 2.13            | 2.9         | -0.912
newbotley   | target    | 2026-10-24 16:00+00:00 | 0.834   | 2.01            | 2.76        | -1.176
osney       | live_only | 2026-10-24 16:00+00:00 | 2.255   | 3.175           | 3.79        | -0.920
```

Everything is below normal today. It also shows that Kings Mill's latest live reading is from 13 Oct, so
the live forecast should treat that gauge as stale.

### e. What compression bought us

```sql
SELECT count(*) AS chunks,
       pg_size_pretty(sum(before_compression_total_bytes)) AS before,
       pg_size_pretty(sum(after_compression_total_bytes))  AS after,
       round(sum(before_compression_total_bytes)::numeric / sum(after_compression_total_bytes), 1) AS ratio
FROM chunk_compression_stats('readings_hourly')
WHERE compression_status = 'Compressed';
```

```
chunks | before | after | ratio
-------+--------+-------+------
41     | 434 MB | 35 MB | 12.4
```

Twenty years of hourly readings for 21 series fit in 35 MB, well inside a free service's 750 MiB.

## Testing

- `make test` runs the unit tests in `tests/test_mirror_tiger.py`: the SQL text, row preparation (UTC
  conversion, NaN to NULL, duplicates), the dry run and the CLI. No database is needed.
- The integration test (`test_integration_mirror_is_idempotent`) runs the real mirror twice and checks it
  is idempotent, that history and live rows coexist, and that the daily view uses UTC days across the clock
  change. It is skipped unless `RC_TEST_DATABASE_URL` points at a scratch Postgres (it works in its own
  `rc_mirror_test` schema and drops it first) or Docker is installed (it then starts
  `timescale/timescaledb:latest-pg16`). It passed against plain Postgres 16 and against the team's Tiger
  service (timescaledb 2.31).
