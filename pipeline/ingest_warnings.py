"""Download EA Historic Flood Warnings and keep the Oxford-related area codes (SPEC §5.1).

Source: data.gov.uk dataset ``historic-flood-warnings2`` (EA product AfA435, OGL). It's a ZIP
holding one ODS spreadsheet (sheet ``tblAllData``) with columns
``DATE | AREA | CODE | WARNING / ALERT AREA NAME | TYPE``. ``DATE`` carries the full issue
date-time, to the second, as naive UK local clock time (Europe/London). Evidence: none of the
~86k national rows falls in a non-existent spring-forward hour, 17 fall in the repeated
autumn hour, and the hour-of-day profile is the same in GMT and BST months (if the times were
UTC it would shift an hour earlier in summer). We convert to UTC; the repeated autumn hour is
read as BST.

Output: ``data/processed/warnings.parquet`` with columns
``area_code: str, type: "alert"|"warning"|"severe", issued_at: datetime64[ns, UTC],
precision: "time"|"date"`` plus two informational columns, ``area_name`` and ``message``
(the raw EA TYPE, e.g. "Update Flood Warning").

The ZIP is cached under ``data/raw/warnings/`` and never re-downloaded once cached.
Issue #13.
"""
from __future__ import annotations

import io
import json
import logging
import os
import time
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from xml.etree.ElementTree import iterparse

import numpy as np
import pandas as pd
import requests

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("RC_DATA_DIR", ROOT / "data"))

CKAN_URL = "https://ckan.publishing.service.gov.uk/api/action/package_show?id=historic-flood-warnings2"
# Resource URL at the time of writing; used if the CKAN lookup fails.
FALLBACK_ZIP_URL = (
    "https://environment.data.gov.uk/api/file/download"
    "?fileDataSetId=766cb094-b392-4bd6-a02e-f60e143f3213&fileName=Historic_Flood_Warnings.zip"
)
LICENCE = "Open Government Licence v3.0"
ZIP_NAME = "Historic_Flood_Warnings.zip"

# Oxford-related target areas (SPEC §5.1), checked against the July 2026 release.
# The named codes start in Nov 2012 (alerts: 2008); before that the EA used numbered reach codes,
# kept here so the 2007 event has official messages too. Pre-2010 alerts were "Flood Watch",
# and in 2006-08 they were also issued on the numbered warning-area codes.
OXFORD_CODES: dict[str, str] = {
    # Thames in Oxford
    "061FWF23BnsyOsny": "Binsey, Osney and Osney Island (warning, 2012-)",
    "061FWF23NwBotley": "New Botley, New and North Hinksey, Grandpont (warning, 2012-)",
    "061FWF23Wlvrcote": "Wolvercote (warning, 2012-)",
    "061WAF23Oxford": "River Thames and tributaries in the Oxford Area (alert, 2008-)",
    "061FWF233": "Legacy: Thames from Eynsham Lock to Sandford Lock (warning/watch, 2006-08)",
    # Cherwell in Oxford
    "061FWF14CherOxfd": "River Cherwell for the Oxford area (warning, 2012-)",
    "061WAF14LChrwell": "River Cherwell from Lower Heyford down to and including Oxford (alert, 2012-)",
    "061FWF142": "Legacy: Cherwell from Lower Heyford to Oxford (warning, 2007)",
    "061WAFW06": "Legacy: River Cherwell catchment (watch, 2006-08)",
}

# EA TYPE text -> contract type. "Flood Watch" was the pre-2010 name for a Flood Alert.
TYPE_MAP: dict[str, str] = {
    "flood watch": "alert",
    "flood alert": "alert",
    "update flood alert": "alert",
    "flood warning": "warning",
    "update flood warning": "warning",
    "severe flood warning": "severe",
    "update severe flood warning": "severe",
}

LOCAL_TZ = "Europe/London"

_NS_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
_NS_OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
_NS_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
_ROW = f"{{{_NS_TABLE}}}table-row"
_CELL = f"{{{_NS_TABLE}}}table-cell"
_COVERED = f"{{{_NS_TABLE}}}covered-table-cell"
_REPEAT = f"{{{_NS_TABLE}}}number-columns-repeated"
_DATE_VALUE = f"{{{_NS_OFFICE}}}date-value"
_P = f"{{{_NS_TEXT}}}p"

OUT_COLUMNS = ["area_code", "type", "issued_at", "precision", "area_name", "message"]


# --------------------------------------------------------------------------- download


def _resolve_zip_url(session: requests.Session) -> str:
    try:
        resp = session.get(CKAN_URL, timeout=30)
        resp.raise_for_status()
        for res in resp.json()["result"]["resources"]:
            if str(res.get("format", "")).upper() == "ZIP" or str(res.get("url", "")).endswith(".zip"):
                return str(res["url"])
    except (requests.RequestException, KeyError, ValueError) as exc:
        log.warning("CKAN lookup failed (%s); using fallback URL", exc)
    return FALLBACK_ZIP_URL


def download_zip(raw_dir: Path | None = None, retries: int = 4) -> tuple[Path, dict[str, str]]:
    """Return the cached ZIP path and its provenance, downloading it only if absent."""
    raw_dir = raw_dir or DATA_DIR / "raw" / "warnings"
    raw_dir.mkdir(parents=True, exist_ok=True)
    zip_path = raw_dir / ZIP_NAME
    meta_path = raw_dir / "download.json"
    if zip_path.exists() and zipfile.is_zipfile(zip_path):
        if meta_path.exists():
            return zip_path, json.loads(meta_path.read_text())
        meta = {"url": FALLBACK_ZIP_URL, "downloaded_at": _mtime_iso(zip_path)}
        meta_path.write_text(json.dumps(meta, indent=2))
        return zip_path, meta

    session = requests.Session()
    url = _resolve_zip_url(session)
    for attempt in range(retries):
        try:
            resp = session.get(url, timeout=300)
            resp.raise_for_status()
            tmp = zip_path.with_suffix(".part")
            tmp.write_bytes(resp.content)
            if not zipfile.is_zipfile(tmp):
                raise ValueError("downloaded file is not a ZIP")
            tmp.replace(zip_path)
            break
        except (requests.RequestException, ValueError) as exc:
            if attempt == retries - 1:
                raise
            wait = 2**attempt * 5
            log.warning("download failed (%s); retrying in %ss", exc, wait)
            time.sleep(wait)
    meta = {"url": url, "downloaded_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
    meta_path.write_text(json.dumps(meta, indent=2))
    return zip_path, meta


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- parsing


def iter_ods_rows(content_xml: io.BufferedIOBase | io.BytesIO) -> Iterator[list[str]]:
    """Stream rows of the first sheet in an ODS ``content.xml`` as lists of strings.

    Date cells yield their ``office:date-value`` (ISO, keeps the time); other cells yield
    their text. Repeated empty trailing cells are dropped.
    """
    for _event, elem in iterparse(content_xml, events=("end",)):
        if elem.tag != _ROW:
            continue
        row: list[str] = []
        for cell in elem:
            if cell.tag not in (_CELL, _COVERED):
                continue
            value = cell.get(_DATE_VALUE)
            if value is None:
                value = "\n".join("".join(p.itertext()) for p in cell.iter(_P))
            repeat = int(cell.get(_REPEAT, "1"))
            if value == "" and repeat > 1:
                continue  # padding to column 16384
            row.extend([value] * repeat)
        elem.clear()
        while row and row[-1] == "":
            row.pop()
        if row:
            yield row


def read_all_warnings(zip_path: Path) -> pd.DataFrame:
    """Every row of the national dataset as strings: date, ea_area, code, name, ea_type."""
    with zipfile.ZipFile(zip_path) as outer:
        ods_name = next(n for n in outer.namelist() if n.lower().endswith(".ods"))
        with zipfile.ZipFile(io.BytesIO(outer.read(ods_name))) as ods, ods.open("content.xml") as fh:
            rows = iter_ods_rows(fh)
            header = next(rows)
            if [h.strip().upper() for h in header[:5]] != [
                "DATE", "AREA", "CODE", "WARNING / ALERT AREA NAME", "TYPE",
            ]:
                raise ValueError(f"unexpected header in {ods_name}: {header}")
            records = [r[:5] + [""] * (5 - len(r)) for r in rows]
    return pd.DataFrame(records, columns=["date", "ea_area", "code", "name", "ea_type"])


def parse_issued_at(values: pd.Series, local_tz: str = LOCAL_TZ) -> tuple[pd.Series, pd.Series]:
    """Parse naive local date(-time) strings to UTC; return (issued_at, precision).

    Precision is "date" when the source has no time of day (date only, or exactly 00:00:00),
    else "time". Date-only values are kept at local midnight, converted to UTC.
    Ambiguous autumn fall-back hours are read as BST (first occurrence); non-existent spring
    hours are shifted forward.
    """
    raw = values.astype(str).str.strip()
    naive = pd.to_datetime(raw, format="ISO8601", errors="coerce")
    has_time = raw.str.contains("T") & (naive.dt.normalize() != naive)
    local = naive.dt.tz_localize(
        local_tz, ambiguous=np.ones(len(naive), dtype=bool), nonexistent="shift_forward"
    )
    issued = local.dt.tz_convert("UTC").astype("datetime64[ns, UTC]")
    precision = has_time.map({True: "time", False: "date"})
    return issued, precision


def to_contract(df: pd.DataFrame, codes: dict[str, str] | None = None) -> pd.DataFrame:
    """Filter national rows to Oxford codes and shape them into the warnings.parquet schema."""
    codes = OXFORD_CODES if codes is None else codes
    sub = df[df["code"].str.strip().isin(codes)].copy()
    sub["message"] = sub["ea_type"].str.strip()
    sub["type"] = sub["message"].str.lower().map(TYPE_MAP)
    unknown = sub.loc[sub["type"].isna(), "message"].unique()
    if len(unknown):
        log.warning("dropping unrecognised warning types: %s", list(unknown))
    sub = sub[sub["type"].notna()]
    issued, precision = parse_issued_at(sub["date"])
    out = pd.DataFrame(
        {
            "area_code": sub["code"].str.strip().astype(str),
            "type": sub["type"].astype(str),
            "issued_at": issued,
            "precision": precision.astype(str),
            "area_name": sub["name"].str.strip().astype(str),
            "message": sub["message"].astype(str),
        }
    )
    out = out[out["issued_at"].notna()]
    out = out.drop_duplicates(["area_code", "type", "issued_at", "message"])
    return out.sort_values(["issued_at", "area_code"]).reset_index(drop=True)[OUT_COLUMNS]


# --------------------------------------------------------------------------- main


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    zip_path, meta = download_zip()
    national = read_all_warnings(zip_path)
    log.info("national rows: %d", len(national))
    out = to_contract(national)
    missing = sorted(set(OXFORD_CODES) - set(out["area_code"]))
    if missing:
        log.warning("no messages found for codes: %s", missing)

    processed = DATA_DIR / "processed"
    processed.mkdir(parents=True, exist_ok=True)
    out.to_parquet(processed / "warnings.parquet", index=False)
    provenance = {
        "name": "EA Historic Flood Warnings (AfA435)",
        "source_url": meta["url"],
        "licence": LICENCE,
        "downloaded_at": meta["downloaded_at"],
        "n_rows": len(out),
        "first_ts": out["issued_at"].min().isoformat() if len(out) else None,
        "last_ts": out["issued_at"].max().isoformat() if len(out) else None,
    }
    (processed / "warnings_provenance.json").write_text(json.dumps(provenance, indent=2))

    summary = out.groupby(["area_code", "type"]).size().unstack(fill_value=0)
    log.info("Oxford messages by area and type:\n%s", summary.to_string())
    log.info("precision: %s", out["precision"].value_counts().to_dict())
    log.info("wrote %s (%d rows)", processed / "warnings.parquet", len(out))


if __name__ == "__main__":
    main()
