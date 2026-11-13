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

1. Load a vocal from the **File** menu (or drop a file on the page), record with the red **●** button, or try the demo. A solo vocal works best.
2. Each sung note is an orange block; the line is the pitch that was sung.
3. **Drag a note** up or down to change its pitch. It snaps to the chosen key and scale; hold **Alt** to move freely.
4. The three knobs work on every note at once. Drag a knob up or down (**Shift** for fine, double-click to reset):
   - **Center** pulls notes towards the nearest note of the scale.
   - **Variation** smooths out vibrato and wobble inside each note.
   - **Transition** sets how quickly pitch glides from one note to the next.
5. **Space** plays and stops. **Original** switches to the untouched audio so you can compare. Drag the ruler to scrub and hear the audio under the playhead.
6. **Export** when you're done.

Tools (left side): **Select** (`V`), **Cut** (`C`, click a note to split it, with optional snapping to the beat), **Pitch line** (`P`, bend the line itself, including the glides between notes; **Shift** for fine adjustment, double-click to straighten), **Merge** (`G`) and **Delete**.

Tempo: the **BPM** box sets the bar and beat grid on the ruler and what cuts snap to. It does not change the speed of the audio.

Other controls: wheel scrolls pitch, **Shift** + wheel scrolls time, **Ctrl** + wheel zooms (or use the zoom buttons, `+`, `-`, `0`); arrow keys move the selected note one scale step; **Backspace** resets a note; **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo; **Ctrl+O** opens, **Ctrl+E** exports; **?** shows help.

## How it works

1. **Pitch tracking** – pYIN-style: for every 5 ms frame YIN proposes several pitch candidates with probabilities, then a Viterbi search over pitch bins (plus an "unvoiced" state) picks the smoothest likely path. This rejects octave errors and one-frame glitches. Runs in a Web Worker.
2. **Note segmentation** – a hidden Markov model with attack / stable / silence states for every half-semitone (the approach of the Tony note tracker), solved with Viterbi. Vibrato and drift stay inside a note; real pitch changes start a new one. Loudness dips split repeated notes, scoops are folded into the note they lead to, and glides the tracker loses between legato notes are closed up.
3. **Resynthesis** – TD-PSOLA: pitch-synchronous grains are re-spaced to change pitch while keeping timing and formants, so the voice keeps its character.

Newtone's own detection is not documented; the three knobs and the tools (cut, glue) are modelled on its manual.

## Tests

```bash
npm test
```

Detection is checked against synthetic singing with known notes (legato, repeated notes, leaps, consonants, vibrato, noise, high and low voices), and the resynthesis is checked for steady loudness and preserved vowel colour.
