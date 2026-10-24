"""Generate the repo QR code as inline SVG and splice it into poster.html.

Run (no project dependency needed):
    uv run --no-project --with segno python docs/poster/make_qr.py

The SVG replaces everything between the QR:BEGIN and QR:END markers in
poster.html, so re-running is idempotent.
"""

from __future__ import annotations

import re
from pathlib import Path

import segno

REPO_URL = "https://github.com/outrolife/FloodOxhack26"
POSTER = Path(__file__).with_name("poster.html")
BEGIN, END = "<!-- QR:BEGIN -->", "<!-- QR:END -->"


def qr_svg(url: str = REPO_URL) -> str:
    """Return an inline <svg> (viewBox only, sized by CSS) for ``url``."""
    qr = segno.make_qr(url, error="m")
    return qr.svg_inline(
        scale=1,
        border=4,  # the quiet zone QR readers need
        omitsize=True,
        svgclass="qr",
        lineclass=None,
        dark="#0b0b0b",
        title="QR code: github.com/outrolife/FloodOxhack26",
    )


def splice(html: str, svg: str) -> str:
    """Put ``svg`` between the markers in ``html``; fail loudly if they are missing."""
    pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)
    if not pattern.search(html):
        raise SystemExit(f"markers {BEGIN} ... {END} not found in {POSTER}")
    return pattern.sub(lambda _: f"{BEGIN}{svg}{END}", html, count=1)


def main() -> None:
    html = POSTER.read_text(encoding="utf-8")
    POSTER.write_text(splice(html, qr_svg()), encoding="utf-8")
    print(f"QR for {REPO_URL} written into {POSTER}")


if __name__ == "__main__":
    main()
