"""pipeline/ingest_warnings.py on a synthetic ODS in a ZIP (no network)."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pandas as pd
import pytest

from pipeline import ingest_warnings as iw

HEADER = ["DATE", "AREA", "CODE", "WARNING / ALERT AREA NAME", "TYPE"]


def _cell(value: str, date: bool = False, repeat: int = 1) -> str:
    rep = f' table:number-columns-repeated="{repeat}"' if repeat > 1 else ""
    if date:
        return (
            f'<table:table-cell office:value-type="date" office:date-value="{value}"{rep}>'
            f"<text:p>{value[:10]}</text:p></table:table-cell>"
        )
    if value == "":
        return f"<table:table-cell{rep}/>"
    return f'<table:table-cell office:value-type="string"{rep}><text:p>{value}</text:p></table:table-cell>'


def _ods_zip(path: Path, rows: list[list[str]]) -> Path:
    body = (
        "<table:table-row>"
        + "".join(_cell(h) for h in HEADER)
        + _cell("", repeat=16379)
        + "</table:table-row>"
    )
    for r in rows:
        body += (
            "<table:table-row>"
            + _cell(r[0], date=True)
            + "".join(_cell(v) for v in r[1:])
            + _cell("", repeat=16379)
            + "</table:table-row>"
        )
    body += (
        '<table:table-row table:number-rows-repeated="1000">' + _cell("", repeat=16384) + "</table:table-row>"
    )
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
        '<office:body><office:spreadsheet><table:table table:name="tblAllData">'
        f"{body}</table:table></office:spreadsheet></office:body></office:document-content>"
    )
    ods = io.BytesIO()
    with zipfile.ZipFile(ods, "w") as z:
        z.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet")
        z.writestr("content.xml", content)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("Historic Flood Warnings.ods", ods.getvalue())
        z.writestr("Documentation.odt", b"not read")
    return path


ROWS = [
    # GMT: 12:56 local = 12:56 UTC
    ["2014-01-06T12:56:13", "SE - West Thames", "061FWF23BnsyOsny", "Binsey and Osney", "Flood Warning"],
    # BST: 21:16 local = 20:16 UTC; pre-2010 "Flood Watch" is an alert
    ["2007-07-20T19:31:25", "TH - West", "061FWF233", "Eynsham to Sandford", "Flood Watch"],
    ["2007-07-21T21:16:39", "TH - West", "061FWF233", "Eynsham to Sandford", "Severe Flood Warning"],
    [
        "2014-02-09T13:28:01",
        "SE - West Thames",
        "061FWF23BnsyOsny",
        "Binsey and Osney",
        "Update Flood Warning",
    ],
    ["2024-11-24T20:25:38", "Thames", "061WAF23Oxford", "Thames in Oxford", "Flood alert"],
    # Not Oxford: dropped
    ["2014-01-06T10:00:00", "SW - Devon", "113WACT2a", "Devon Coast", "Flood Alert"],
]


@pytest.fixture
def national(tmp_path: Path) -> pd.DataFrame:
    return iw.read_all_warnings(_ods_zip(tmp_path / "w.zip", ROWS))


def test_reads_every_row_and_keeps_time(national: pd.DataFrame) -> None:
    assert len(national) == len(ROWS)
    assert national["date"].iloc[0] == "2014-01-06T12:56:13"
    assert list(national.columns) == ["date", "ea_area", "code", "name", "ea_type"]


def test_contract_schema_and_filter(national: pd.DataFrame) -> None:
    out = iw.to_contract(national)
    assert list(out.columns) == iw.OUT_COLUMNS
    assert str(out["issued_at"].dtype) == "datetime64[ns, UTC]"
    assert set(out["area_code"]) <= set(iw.OXFORD_CODES)
    assert "113WACT2a" not in set(out["area_code"])
    assert set(out["type"]) <= {"alert", "warning", "severe"}
    assert set(out["precision"]) == {"time"}
    assert out["issued_at"].is_monotonic_increasing


def test_type_mapping_and_utc(national: pd.DataFrame) -> None:
    out = iw.to_contract(national).set_index("message")
    assert out.loc["Flood Watch", "type"] == "alert"
    assert out.loc["Flood alert", "type"] == "alert"
    assert out.loc["Update Flood Warning", "type"] == "warning"
    assert out.loc["Severe Flood Warning", "type"] == "severe"
    # BST in July: local 21:16:39 -> 20:16:39Z
    assert out.loc["Severe Flood Warning", "issued_at"] == pd.Timestamp("2007-07-21T20:16:39Z")
    # GMT in January: unchanged
    assert out.loc["Flood Warning", "issued_at"] == pd.Timestamp("2014-01-06T12:56:13Z")


def test_clock_change_night_2026() -> None:
    """Local times across the 25 Oct 2026 fall-back (00:30-02:30 UTC) convert monotonically."""
    local = pd.Series(["2026-10-25T00:30:00", "2026-10-25T01:30:00", "2026-10-25T02:30:00"])
    issued, precision = iw.parse_issued_at(local)
    assert list(issued) == [
        pd.Timestamp("2026-10-24T23:30:00Z"),
        pd.Timestamp("2026-10-25T00:30:00Z"),  # repeated hour read as BST
        pd.Timestamp("2026-10-25T02:30:00Z"),
    ]
    assert list(precision) == ["time"] * 3


def test_date_only_precision() -> None:
    issued, precision = iw.parse_issued_at(
        pd.Series(["2014-01-06", "2007-07-21T00:00:00", "2014-01-06T08:00:00"])
    )
    assert list(precision) == ["date", "date", "time"]
    assert issued.iloc[1] == pd.Timestamp("2007-07-20T23:00:00Z")  # local midnight in BST


def test_bad_header_raises(tmp_path: Path) -> None:
    path = _ods_zip(tmp_path / "w.zip", [])
    with zipfile.ZipFile(path) as z:
        ods = z.read("Historic Flood Warnings.ods")
    with zipfile.ZipFile(io.BytesIO(ods)) as o:
        content = o.read("content.xml").decode().replace("WARNING / ALERT AREA NAME", "NAME")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as o:
        o.writestr("content.xml", content)
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("x.ods", buf.getvalue())
    with pytest.raises(ValueError):
        iw.read_all_warnings(bad)


def test_cached_zip_is_not_redownloaded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ods_zip(tmp_path / iw.ZIP_NAME, ROWS)

    def no_network(*args: object, **kwargs: object) -> None:
        raise AssertionError("network used although the ZIP is cached")

    monkeypatch.setattr(iw.requests.Session, "get", no_network)
    path, meta = iw.download_zip(tmp_path)
    assert path == tmp_path / iw.ZIP_NAME
    assert "downloaded_at" in meta and "url" in meta
