# FloodClock poster (A3)

`poster.html` is a one-page A3 portrait poster for the judging table. It is self-contained: inline CSS and SVG, no fonts, images or scripts loaded from anywhere, so it opens offline.

## Print it (or save as PDF)

1. Open `docs/poster/poster.html` in Chrome, Edge or Safari.
2. Print (Cmd/Ctrl + P), then set:
   - **Paper size: A3**, **Portrait**
   - **Margins: Default** (the page sets 12 mm itself)
   - **Scale: 100%** (not "Fit to page")
   - **Background graphics: on** (otherwise the header band and chart colours drop out)
3. Destination: the printer, or **Save as PDF** for a file to send to a print shop.

Check that the preview is one page and that the disclaimer box at the bottom is visible. If a different system font pushes it to a second page, set Scale to 97%.

No A3 printer? Print on A4 with Scale "Fit to page": everything shrinks to 71% and stays readable at arm's length, but not from 1.5 m.

## Where the numbers come from

Every number on the poster comes from a committed file, and each one has an HTML comment beside it naming its source (`<!-- src: ... -->`):

- `web/public/data/travel_times.json`: travel times (Cassington to New Botley 9.5 h, n = 24; Enslow to Kings Mill 18.6 h, n = 6)
- `web/public/data/proof.json`: skill vs persistence by lead (`skillByLead`), floods caught, false alarms, lead times and lead vs EA warnings at a 50% trigger (`tradeoff`, `pStar` 0.5)
- `web/public/data/replays/e2014.json` and `e2026.json`: the 2014 replay timings and the 2026 near-miss maximum
- `docs/tiger-data.md`: Tiger Data row count and compression

If those files change (for example a new `make backtest`), update the numbers by hand: search `poster.html` for `src:` and check each one. The bar chart's bar heights are drawn from the `pinballModel` and `pinballPersistence` values (scale: 0.035 = 212 SVG units, baseline y = 262).

## Regenerate the QR code

The QR code points to https://github.com/outrolife/FloodOxhack26. It is inline SVG between the `<!-- QR:BEGIN -->` and `<!-- QR:END -->` markers. To rebuild it (idempotent, no project dependency added):

```sh
uv run --no-project --with segno python docs/poster/make_qr.py
```

## Design rules

- App palette from `web/src/styles.css`: blue (`--series-1`) is FloodClock, orange (`--series-2`) is persistence. Status colours are not used.
- System font stack. No GOV.UK or EA branding: the poster must never look like an official warning.
- The disclaimer stays on the poster: "Decision-support prototype, not an official warning. Check gov.uk/check-flooding."
