"""Minimal RGBA PNG writer (stdlib + numpy), so S3 needs no imaging dependency."""

from __future__ import annotations

import struct
import zlib

import numpy as np

PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_rgba_png(rgba: np.ndarray) -> bytes:
    """Encode an (H, W, 4) uint8 RGBA array (row 0 = top/north) as an 8-bit truecolour+alpha PNG."""
    a = np.asarray(rgba)
    if a.ndim != 3 or a.shape[2] != 4 or a.dtype != np.uint8:
        raise ValueError("rgba must be an (H, W, 4) uint8 array")
    h, w, _ = a.shape
    raw = np.zeros((h, w * 4 + 1), dtype=np.uint8)  # leading filter byte 0 (None) per row
    raw[:, 1:] = a.reshape(h, w * 4)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw.tobytes(), 9))
        + _chunk(b"IEND", b"")
    )
