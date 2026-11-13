# webtone

Pitch correction in the browser. Load a vocal, see the notes on a piano roll, drag them into tune, export a WAV.

## Run

```bash
npm install
npm run dev
```

## Live

Deployed with GitHub Pages: https://smackabooble.github.io/webtone/

## Use

- **Open** or drop an audio file (monophonic works best, e.g. a single voice).
- Drag a note up or down to change its pitch. Hold **Alt** for free (unsnapped) movement.
- Double-click a note to reset it.
- Pick a **key** and **scale** to limit snapping to those notes; rows outside the scale are dimmed.
- **Snap all** moves every note to the nearest note in the scale.
- Drag the ruler (or empty space) to scrub the playhead. **Space** plays and stops.
- Mouse wheel scrolls pitch, **Shift + wheel** scrolls time, **Ctrl + wheel** zooms.
- **Ctrl + Z** undoes.

## How it works

1. **Pitch detection** – YIN on a downsampled copy, in a Web Worker.
2. **Segmentation** – the pitch curve is split into notes.
3. **Resynthesis** – TD-PSOLA: pitch-synchronous grains are re-spaced to change pitch while keeping timing and formants.

## Tests

```bash
npm test
```
