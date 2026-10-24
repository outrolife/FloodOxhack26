"""Minimal indexed-colour PNG writer (stdlib + numpy), so S3 needs no imaging dependency.

An 8-bit palette image with a tRNS chunk gives per-class transparency and compresses well,
which keeps the overlays small (CLAUDE.md rule 6).
"""

from __future__ import annotations

import struct
import zlib
from collections.abc import Sequence
from pathlib import Path

import numpy as np

RGBA = tuple[int, int, int, int]


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_indexed_png(index: np.ndarray, palette: Sequence[RGBA]) -> bytes:
    """Encode a 2-D array of palette indices (row 0 = top/north) as PNG bytes.

    ``palette`` is a list of RGBA tuples; alpha goes in the tRNS chunk.
    """
    idx = np.asarray(index)
    if idx.ndim != 2:
        raise ValueError("index must be 2-D")
    if not 1 <= len(palette) <= 256:
        raise ValueError("palette needs 1-256 entries")
    if idx.size and (idx.min() < 0 or idx.max() >= len(palette)):
        raise ValueError("index out of palette range")
    h, w = idx.shape
    idx = idx.astype(np.uint8)
    if len(palette) <= 16:  # 4-bit: two pixels per byte, high nibble first
        depth = 4
        if w % 2:
            idx = np.pad(idx, ((0, 0), (0, 1)))
        packed = (idx[:, 0::2] << 4) | idx[:, 1::2]
    else:
        depth, packed = 8, idx
    raw = np.zeros((h, packed.shape[1] + 1), dtype=np.uint8)  # leading filter byte 0 (None) per row
    raw[:, 1:] = packed
    ihdr = struct.pack(">IIBBBBB", w, h, depth, 3, 0, 0, 0)
    plte = b"".join(bytes(c[:3]) for c in palette)
    trns = bytes(c[3] for c in palette)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"PLTE", plte)
        + _chunk(b"tRNS", trns)
        + _chunk(b"IDAT", zlib.compress(raw.tobytes(), 9))
        + _chunk(b"IEND", b"")
    )


def write_indexed_png(path: Path, index: np.ndarray, palette: Sequence[RGBA]) -> int:
    """Write the PNG; return its size in bytes."""
    data = encode_indexed_png(index, palette)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data)
