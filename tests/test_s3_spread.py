"""Tests for the S3 flood-spread ensemble (stretch/s3, SPEC §11 S3) on a synthetic DTM.

No network or geodata libraries needed: everything here uses numpy/scipy only.
"""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

import numpy as np
import pytest
from test_fixtures import LEADS, SPREAD_MANIFEST, check, parse_utc

from model.probability import ALPHAS, cdf
from stretch.s3 import spread as s3
from stretch.s3.png import PNG_SIGNATURE, encode_rgba_png

PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "stretch" / "spread" / "e2014" / "manifest.json"


def synthetic() -> tuple[np.ndarray, np.ndarray]:
    """A 30x40 valley: a river in column 2, ground rising eastwards, and an isolated pit.

    The pit (rows 10-14, cols 25-29) sits at 50.0 m, behind ground at 53+ m, so it is below a
    51 m water level but not connected to the river.
    """
    ny, nx = 30, 40
    x = np.arange(nx)
    dtm = np.tile(50.0 + 0.1 * x, (ny, 1))  # 50.0 at the river, 53.9 at the east edge
    dtm[10:15, 25:30] = 50.0
    river = np.zeros((ny, nx), dtype=bool)
    river[:, 2] = True
    return dtm, river


def test_connectivity_excludes_isolated_depression() -> None:
    dtm, river = synthetic()
    wet = s3.wet_mask(dtm, 51.0, river)
    assert wet[:, 2].all(), "river cells are wet"
    assert wet[:, :10].all(), "ground below the level next to the river is wet"
    assert not wet[10:15, 25:30].any(), "a pit below the level but cut off from the river stays dry"
    assert not wet[:, 11:].any(), "nothing above the level is wet"


def test_diagonal_contact_does_not_connect() -> None:
    """4-connectivity: water does not leak through a diagonal gap between two high cells."""
    dtm = np.full((5, 5), 60.0)
    river = np.zeros((5, 5), dtype=bool)
    river[0, 0] = True
    dtm[0, 0] = 50.0
    dtm[1, 1] = 50.0  # touches the river cell only at a corner
    wet = s3.wet_mask(dtm, 55.0, river)
    assert wet[0, 0] and not wet[1, 1]


def test_spill_index_matches_per_level_fill() -> None:
    rng = np.random.default_rng(0)
    dtm, river = synthetic()
    dtm = dtm + rng.normal(0, 0.3, dtm.shape)
    levels = np.round(np.arange(50.0, 54.0, 0.05), 4)
    spill = s3.spill_index(dtm, river, levels)
    for j, lev in enumerate(levels):
        np.testing.assert_array_equal(spill <= j, s3.wet_mask(dtm, float(lev), river), err_msg=f"level {lev}")


def test_frequency_is_monotone_in_wse() -> None:
    dtm, river = synthetic()
    ens = s3.build_ensemble(dtm, river, 50.0, 54.0, n_runs=20, radius_cells=2.0, seed=1)
    prev = np.zeros(dtm.shape)
    for wse in np.arange(50.0, 54.0, 0.1):
        freq = ens.frequency(np.full(ens.runs, wse))
        assert ((freq >= 0) & (freq <= 1)).all()
        assert (freq >= prev - 1e-12).all(), f"frequency fell somewhere when WSE rose to {wse:.2f}"
        prev = freq
    assert prev[:, 2].min() == 1.0  # the river is always wet
    low = ens.frequency(np.full(ens.runs, 51.0))
    assert low[10:15, 25:30].max() == 0.0, "the pit stays dry while the ridge (>= 52.5 m) holds"


def test_ensemble_is_reproducible() -> None:
    dtm, river = synthetic()
    a = s3.build_ensemble(dtm, river, 50.0, 53.0, n_runs=5, radius_cells=2.0, seed=7)
    b = s3.build_ensemble(dtm, river, 50.0, 53.0, n_runs=5, radius_cells=2.0, seed=7)
    np.testing.assert_array_equal(a.spill, b.spill)
    np.testing.assert_array_equal(a.u, b.u)


def test_noise_field_has_target_sigma() -> None:
    f = s3.noise_field((80, 80), np.random.default_rng(3), 0.15, 5.0)
    assert abs(float(f.std()) - 0.15) < 1e-4


def test_inverse_cdf_inverts_spec_cdf() -> None:
    q = np.array([1.0, 1.1, 1.3, 1.5, 1.6, 1.9, 2.1])
    u = np.array([0.01, 0.05, 0.2, 0.5, 0.8, 0.95, 0.99])
    x = s3.inverse_cdf(q, u)
    np.testing.assert_allclose(cdf(np.tile(q, (len(u), 1)), x), u, atol=1e-9)
    np.testing.assert_allclose(s3.inverse_cdf(q, np.asarray(ALPHAS)), q)


def test_stratified_uniforms_cover_each_stratum() -> None:
    u = s3.stratified_uniforms(200)
    assert sorted(np.floor(u * 200).astype(int)) == list(range(200))


def _decode_png(data: bytes) -> np.ndarray:
    """Decode an unfiltered 8-bit RGBA PNG (what ``encode_rgba_png`` writes)."""
    assert data[:8] == PNG_SIGNATURE
    i, idat, ihdr = 8, b"", b""
    while i < len(data):
        n = struct.unpack(">I", data[i : i + 4])[0]
        tag, body = data[i + 4 : i + 8], data[i + 8 : i + 8 + n]
        assert struct.unpack(">I", data[i + 8 + n : i + 12 + n])[0] == zlib.crc32(tag + body) & 0xFFFFFFFF
        if tag == b"IHDR":
            ihdr = body
        elif tag == b"IDAT":
            idat += body
        i += 12 + n
    w, h, depth, ctype = struct.unpack(">IIBB", ihdr[:10])
    assert (depth, ctype) == (8, 6)
    rows = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(h, -1)
    assert (rows[:, 0] == 0).all()
    return rows[:, 1:].reshape(h, w, 4)


def test_png_round_trip() -> None:
    rgba = np.random.default_rng(0).integers(0, 256, (5, 7, 4)).astype(np.uint8)
    np.testing.assert_array_equal(_decode_png(encode_rgba_png(rgba)), rgba)


def test_colour_ramp_matches_agreed_stops() -> None:
    f = np.array([np.nan, 0.0, 0.049, 0.05, 0.30, 0.50, 0.75, 1.0, 0.4])
    c = s3.colourise(f[None, :])[0]
    assert (c[:3] == 0).all(), "NaN and < 0.05 are fully transparent"
    expected = ["1a9850", "91cf60", "fee08b", "fc8d59", "d73027"]
    assert [bytes(px[:3].tolist()).hex() for px in c[3:8]] == expected
    assert (c[3:, 3] == round(0.85 * 255)).all()
    # 0.4 is halfway between the 0.30 and 0.50 stops
    np.testing.assert_allclose(
        c[8, :3], np.round((np.array([0x91, 0xCF, 0x60]) + [0xFE, 0xE0, 0x8B]) / 2), atol=1
    )


def test_block_mean_ignores_excluded_cells() -> None:
    a = np.zeros((10, 10))
    a[:5, :5] = 1.0
    ex = np.zeros((10, 10), dtype=bool)
    ex[:5, 5:] = True  # a whole block excluded -> NaN
    ex[5, 5] = True
    a[5, 5] = 100.0  # excluded, must not count
    b = s3.block_mean(a, ex)
    assert b.shape == (2, 2)
    assert b[0, 0] == 1.0 and np.isnan(b[0, 1]) and b[1, 1] == 0.0


def _manifests() -> list[Path]:
    found = sorted(PUBLIC.glob("spread/*/manifest.json"))
    return [FIXTURE, *found]


@pytest.mark.parametrize(
    "path", _manifests(), ids=lambda p: str(p.parent.name) + ("-fixture" if "fixtures" in str(p) else "")
)
def test_manifest_matches_contract(path: Path) -> None:
    m = json.loads(path.read_text(encoding="utf-8"))
    check(m, SPREAD_MANIFEST, "spread_manifest")
    (lat_s, lon_w), (lat_n, lon_e) = m["bounds"]
    assert lat_s < lat_n and lon_w < lon_e
    assert m["runs"] > 0 and m["frames"], "at least one frame"
    for f in m["frames"]:
        assert f["tau"] in LEADS
        parse_utc(f["issuedAt"])
    if m["validation"] is not None:
        assert 0 <= m["validation"]["iou"] <= 1
    assert any("Experimental." in c for c in m["caveats"])
    if "fixtures" in str(path):
        return
    # Committed outputs: the exact SPEC caveat, every PNG present and sized to the overlay grid.
    assert s3.CAVEATS_BASE[0] in m["caveats"]
    assert m["bounds"] == s3.BOUNDS_WGS84
    ov = s3.overlay_grid()
    for f in m["frames"]:
        assert f["png"].startswith(f"spread/{path.parent.name}/"), "png paths are relative to /data/"
        png = PUBLIC / f["png"]
        assert png.is_file(), f"missing {f['png']}"
        w, h = struct.unpack(">II", png.read_bytes()[16:24])
        assert (w, h) == (ov.width, ov.height)
    keys = [(f["issuedAt"], f["tau"]) for f in m["frames"]]
    assert len(keys) == len(set(keys)), "one frame per (issuedAt, tau)"


def test_committed_spread_is_small() -> None:
    total = (
        sum(p.stat().st_size for p in (PUBLIC / "spread").rglob("*") if p.is_file())
        if (PUBLIC / "spread").is_dir()
        else 0
    )
    assert total < 5 * 1024 * 1024
