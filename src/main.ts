import './spectrum';
import './style.css';
import { PianoRoll, type Tool } from './ui/pianoroll';
import { paletteFromTheme } from './ui/palette';
import { barBeat, clampBpm, formatTime } from './dsp/grid';
import { segment, notePitch, type Note } from './dsp/segment';
import { psola } from './dsp/psola';
import type { Analysis } from './dsp/analyze';
import { encodeWav } from './audio/wav';
import { makeDemo } from './audio/demo';
import { GRAIN_SEC, grainGain, grainHop, hannCurve } from './audio/scrub';
import { KEY_NAMES, SCALES, scaleMask, snapToScale, midiName, stepInScale } from './dsp/scale';
import { autoShift, frameShifts, isNeutral, totalShift, type Params } from './dsp/render';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Spectrum buttons, sliders and fields are custom elements; these are the bits of them used here. */
type Control = HTMLElement & { disabled: boolean; selected: boolean; value: string | number };
const btn = (id: string) => $<Control>(id);
const field = (id: string) => $<Control>(id);
const menuItem = (value: string, text: string) => {
  const el = document.createElement('sp-menu-item');
  el.setAttribute('value', value);
  el.textContent = text;
  return el;
};

const stage = $('stage');
const fileInput = $<HTMLInputElement>('file');
const roll = new PianoRoll($<HTMLCanvasElement>('roll'));

let ctx: AudioContext | null = null;
const audio = () => (ctx ??= new AudioContext());

let original: AudioBuffer | null = null;
let rendered: AudioBuffer | null = null;
let analysis: Analysis | null = null;
let notes: Note[] = [];
let fileName = 'webtone';
let bypass = false;
/** Hand edits to the pitch line, in semitones per analysis frame. */
let curve = new Float32Array(0);

const params: Params = { center: 0, variation: 0, transitionMs: 25, mask: scaleMask(0, SCALES.Chromatic) };

// ---------- Status line ----------

let flashTimer = 0;

function baseStatus(): string {
  if (!original) return '';
  const i = roll.selectedIndex;
  if (i >= 0 && notes[i]) {
    const n = notes[i];
    const to = n.pitch + totalShift(n, params);
    const same = midiName(n.pitch) === midiName(to) && Math.abs(to - n.pitch) < 0.5;
    return same
      ? `${notes.length} notes · selected ${midiName(n.pitch)}`
      : `${notes.length} notes · selected ${midiName(n.pitch)} → ${midiName(to)}`;
  }
  return notes.length ? `${notes.length} notes` : '';
}

function setStatus(s: string) {
  $('status').textContent = s;
}

/** Show a message for a few seconds, then go back to the normal status. */
function flash(msg: string, problem = false) {
  setStatus(msg);
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => setStatus(baseStatus()), 4000);
  if (problem) toast(msg);
}

/** A Spectrum toast, for things that went wrong and need to be noticed. */
function toast(msg: string, variant: 'negative' | 'info' = 'negative') {
  const t = document.createElement('sp-toast');
  t.setAttribute('open', '');
  t.setAttribute('variant', variant);
  t.setAttribute('timeout', '6000');
  t.textContent = msg;
  t.addEventListener('close', () => t.remove());
  $('toasts').append(t);
}

function setBusy(text: string | null) {
  $('busy').hidden = text === null;
  if (text) $('busyText').textContent = text;
}

// ---------- Undo / redo ----------

interface Snap {
  notes: Note[];
  curve: Float32Array;
}
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];
const snapshot = (): Snap => ({ notes: notes.map((n) => ({ ...n })), curve: curve.slice() });

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  updateButtons();
}

function restore(s: Snap) {
  notes = s.notes.map((n) => ({ ...n }));
  curve.set(s.curve);
  roll.setNotes(notes);
  commit();
}

function undo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(snapshot());
  restore(s);
}

function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(snapshot());
  restore(s);
}

function updateButtons() {
  const loaded = original !== null;
  for (const id of ['play', 'ab', 'cut', 'curveTool', 'reset']) btn(id).disabled = !loaded;
  document.querySelectorAll<Control>('[data-action="export"]').forEach((b) => (b.disabled = !loaded));
  const sel = roll.selectedIndex;
  btn('merge').disabled = !loaded || notes.length < 2 || sel < 0;
  btn('delete').disabled = !loaded || sel < 0;
  btn('undo').disabled = undoStack.length === 0;
  btn('redo').disabled = redoStack.length === 0;
  updateNotePanel();
}

// ---------- Loading & analysis ----------

async function loadFile(file: File) {
  stop();
  setBusy('Reading audio…');
  try {
    const buf = await audio().decodeAudioData(await file.arrayBuffer());
    fileName = file.name.replace(/\.[^.]+$/, '');
    await loadBuffer(buf);
  } catch (err) {
    console.error(err);
    setBusy(null);
    flash("Couldn't read that file. Try a WAV or MP3.", true);
  }
}

async function loadBuffer(buf: AudioBuffer) {
  stop();
  setBusy('Analysing pitch…');
  $('hint').hidden = true;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }

  let result: Analysis;
  try {
    result = await new Promise<Analysis>((resolve, reject) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        resolve(e.data as Analysis);
        worker.terminate();
      };
      worker.onerror = (e) => {
        reject(e);
        worker.terminate();
      };
      worker.postMessage({ mono, sr: buf.sampleRate }, [mono.buffer]);
    });
  } catch (err) {
    console.error(err);
    setBusy(null);
    $('hint').hidden = original !== null;
    flash('Analysis failed.', true);
    return;
  }

  original = buf;
  rendered = buf;
  analysis = result;
  notes = segment(result.f0, result.hopSec, result.db);
  undoStack.length = 0;
  redoStack.length = 0;
  playOffset = 0;
  setBypass(false);
  setTool('select');
  resetControls();
  curve = new Float32Array(result.f0.length);
  roll.curve = curve;
  roll.setData(notes, result.f0, result.env, result.hopSec, buf.duration);
  refreshShifts();
  setBusy(null);
  updateButtons();
  if (notes.length) setStatus(baseStatus());
  else {
    flash('No pitched notes found. A clean solo vocal works best.');
    toast('No pitched notes found. A clean solo vocal works best.', 'info');
  }
}

// ---------- Rendering ----------

/** Update the pitch curve shown on the roll from the current notes and controls. */
function refreshShifts() {
  if (!analysis) return;
  roll.frameShift = frameShifts(notes, analysis.f0, analysis.hopSec, params, curve);
  roll.invalidate();
}

function render() {
  if (!original || !analysis) return;
  if (isNeutral(notes, params, curve)) {
    rendered = original;
    return;
  }
  const { f0, hopSec, marks } = analysis;
  const sr = original.sampleRate;
  const shifts = frameShifts(notes, f0, hopSec, params, curve);
  const ratio = new Float32Array(shifts.length);
  for (let i = 0; i < ratio.length; i++) ratio[i] = Math.pow(2, shifts[i] / 12);
  const framesPerSample = 1 / (sr * hopSec);
  const last = ratio.length - 1;
  const ratioAt = (sample: number) => ratio[Math.min(last, Math.round(sample * framesPerSample))];

  const out = audio().createBuffer(original.numberOfChannels, original.length, sr);
  for (let c = 0; c < original.numberOfChannels; c++) {
    out.copyToChannel(psola(original.getChannelData(c), marks, ratioAt), c);
  }
  rendered = out;
}

/** Apply an edit: refresh the curve, rebuild the audio, and keep playing if it was playing. */
function commit() {
  refreshShifts();
  const was = isPlaying();
  stop();
  render();
  updateButtons();
  setStatus(baseStatus());
  roll.invalidate();
  if (was) play();
}

let renderTimer = 0;
function scheduleCommit() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(commit, 160);
}

// ---------- Playback ----------

let source: AudioBufferSourceNode | null = null;
let playStartedAt = 0;
let playOffset = 0;

const isPlaying = () => source !== null;
const current = () => (bypass ? original : rendered);

function currentTime() {
  const buf = current();
  if (!isPlaying() || !buf) return playOffset;
  return Math.min(buf.duration, playOffset + audio().currentTime - playStartedAt);
}

function play() {
  const buf = current();
  if (!buf) return;
  const a = audio();
  void a.resume();
  if (playOffset >= buf.duration - 0.01) playOffset = 0;
  const node = a.createBufferSource();
  node.buffer = buf;
  node.connect(a.destination);
  node.onended = () => {
    if (source !== node) return;
    source = null;
    playOffset = 0;
    setPlayIcon(false);
    setPlayhead(0, false);
  };
  node.start(0, playOffset);
  playStartedAt = a.currentTime;
  source = node;
  setPlayIcon(true);
}

function stop() {
  if (!source) return;
  playOffset = currentTime();
  const node = source;
  source = null;
  node.onended = null;
  node.stop();
  setPlayIcon(false);
}

function setPlayIcon(playing: boolean) {
  btn('play').toggleAttribute('data-playing', playing);
  btn('play').setAttribute('aria-label', playing ? 'Stop' : 'Play');
}

/** Move the playhead on the roll and update the time and bar readout. */
function setPlayhead(t: number, follow: boolean) {
  roll.setPlayhead(t, follow);
  const { bar, beat } = barBeat(t, bpm);
  $('rdTime').textContent = formatTime(t);
  $('rdBar').textContent = `${bar}.${beat}`;
}

function togglePlay() {
  if (!current()) return;
  if (isPlaying()) stop();
  else play();
}

function setBypass(on: boolean) {
  const was = isPlaying();
  stop();
  bypass = on;
  btn('ab').selected = on;
  if (was) play();
}

// Dragging the playhead pauses playback and plays the audio under it, like Newtone. The sound
// is held for as long as the playhead is held, at the pitch that is there (see audio/scrub.ts).
let resumeAfterScrub = false;
let scrubbing = false;
let scrubTimer = 0;
let nextGrainAt = 0;
const hann = hannCurve();

/** Length of one pitch period in the (corrected) audio at a position, or 0 if unvoiced. */
function periodAt(pos: number): number {
  if (!analysis) return 0;
  const f = Math.min(analysis.f0.length - 1, Math.max(0, Math.round(pos / analysis.hopSec)));
  const hz = analysis.f0[f];
  if (!(hz > 0)) return 0;
  const shift = bypass ? 0 : (roll.frameShift?.[f] ?? 0);
  return 1 / (hz * Math.pow(2, shift / 12));
}

function scheduleGrains() {
  const buf = current();
  if (!scrubbing || !buf) return;
  const a = audio();
  const now = a.currentTime;
  if (nextGrainAt < now) nextGrainAt = now + 0.005;
  // Schedule a little ahead on the audio clock so the spacing is exact.
  while (nextGrainAt < now + 0.06) {
    const pos = playOffset;
    const hop = grainHop(periodAt(pos));
    const node = a.createBufferSource();
    node.buffer = buf;
    const gain = a.createGain();
    gain.gain.value = 0;
    gain.gain.setValueCurveAtTime(hann.map((v) => v * grainGain(hop)), nextGrainAt, GRAIN_SEC);
    node.connect(gain).connect(a.destination);
    node.start(nextGrainAt, Math.max(0, Math.min(pos - GRAIN_SEC / 2, buf.duration)), GRAIN_SEC);
    nextGrainAt += hop;
  }
}

function scrubStart() {
  resumeAfterScrub = isPlaying();
  stop();
  void audio().resume();
  scrubbing = true;
  nextGrainAt = 0;
  window.clearInterval(scrubTimer);
  scrubTimer = window.setInterval(scheduleGrains, 15);
}

function scrub(t: number) {
  playOffset = t;
  setPlayhead(t, false);
}

function scrubEnd() {
  scrubbing = false;
  window.clearInterval(scrubTimer);
  if (resumeAfterScrub) play();
  resumeAfterScrub = false;
}

function tick() {
  if (isPlaying()) setPlayhead(currentTime(), true);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Scale ----------

const keySel = field('key');
const scaleSel = field('scale');
KEY_NAMES.forEach((name, i) => keySel.append(menuItem(String(i), name)));
Object.keys(SCALES).forEach((name) => scaleSel.append(menuItem(name, name)));
keySel.value = '0';
scaleSel.value = 'Chromatic';

function updateScale() {
  params.mask = scaleMask(Number(keySel.value), SCALES[String(scaleSel.value)] ?? SCALES.Chromatic);
  keySel.disabled = scaleSel.value === 'Chromatic';
  roll.scale = params.mask;
  roll.snap = (p) => snapToScale(p, params.mask);
  refreshShifts();
  scheduleCommit();
}
keySel.addEventListener('change', updateScale);
scaleSel.addEventListener('change', updateScale);

roll.shiftOf = (n) => totalShift(n, params);
roll.scale = params.mask;
roll.snap = (p) => snapToScale(p, params.mask);
keySel.disabled = true;

// ---------- Controls (Center / Variation / Transition) ----------

function syncParams() {
  params.center = Number(field('sCenter').value) / 100;
  params.variation = Number(field('sVariation').value) / 100;
  params.transitionMs = Number(field('sTransition').value);
}

for (const id of ['sCenter', 'sVariation', 'sTransition']) {
  field(id).addEventListener('input', () => {
    syncParams();
    refreshShifts();
    scheduleCommit();
  });
}

/** Put the sliders back to their starting values (does not re-render by itself). */
function resetControls() {
  field('sCenter').value = 0;
  field('sVariation').value = 0;
  field('sTransition').value = 25;
  syncParams();
}

// ---------- Tempo ----------

let bpm = 120;
const bpmInput = field('bpm');
bpmInput.addEventListener('change', () => {
  bpm = clampBpm(Number(bpmInput.value));
  bpmInput.value = bpm;
  roll.bpm = bpm;
  roll.invalidate();
  updateSnap();
  setPlayhead(currentTime(), false);
});
field('snap').addEventListener('change', () => updateSnap());
function updateSnap() {
  roll.snapStepSec = Number(field('snap').value) * (60 / bpm);
}

// ---------- Editing notes ----------

roll.onEditStart = pushUndo;
roll.onEdit = commit;
roll.onSeekStart = scrubStart;
roll.onSeek = scrub;
roll.onSeekEnd = scrubEnd;
roll.onSelect = () => {
  updateButtons();
  setStatus(baseStatus());
};

/** The "Selected note" section: what the note was, where it is now, and an exact offset. */
function updateNotePanel() {
  const n = original ? notes[roll.selectedIndex] : undefined;
  const offset = field('noteOffset');
  field('noteReset').disabled = !n || n.shift === 0;
  offset.disabled = !n;
  if (!n) {
    $('noteInfo').textContent = 'No note selected';
    offset.value = 0;
    return;
  }
  const to = n.pitch + totalShift(n, params);
  $('noteInfo').textContent = midiName(n.pitch) === midiName(to) ? midiName(n.pitch) : `${midiName(n.pitch)} → ${midiName(to)}`;
  offset.value = Math.round(n.shift * 100) / 100;
}

field('noteOffset').addEventListener('change', () => {
  const n = notes[roll.selectedIndex];
  const v = Number(field('noteOffset').value);
  if (!n || !Number.isFinite(v) || Math.abs(v - n.shift) < 1e-6) return;
  pushUndo();
  n.shift = Math.max(-12, Math.min(12, v));
  commit();
});
field('noteReset').addEventListener('click', () => resetSelected());

const toolGroup = $<HTMLElement & { selected: string[] }>('tools');

function setTool(tool: Tool) {
  roll.tool = tool;
  toolGroup.selected = [tool];
  // Options for the other tools stay visible but disabled, so the panel never changes shape.
  field('sBrush').disabled = tool !== 'curve';
  field('snap').disabled = tool !== 'cut';
  roll.canvasCursor('default');
  roll.invalidate();
}
// A tool can't be switched off, only swapped for another.
toolGroup.addEventListener('change', () => setTool((toolGroup.selected[0] as Tool | undefined) ?? roll.tool));

roll.onCurveLive = refreshShifts;
field('sBrush').addEventListener('input', () => {
  roll.brushSec = Number(field('sBrush').value) / 1000;
  roll.invalidate();
});

roll.onCut = (i, frame) => {
  if (!analysis) return;
  const n = notes[i];
  const margin = Math.max(3, Math.round(0.03 / analysis.hopSec));
  if (frame - n.start < margin || n.end - frame < margin) {
    flash('Too close to the edge of the note to cut there.');
    return;
  }
  pushUndo();
  const { f0 } = analysis;
  const a: Note = { ...n, end: frame, pitch: notePitch(f0, n.start, frame) };
  const b: Note = { ...n, start: frame, pitch: notePitch(f0, frame, n.end) };
  notes.splice(i, 1, a, b);
  roll.setNotes(notes, i + 1);
  commit();
};

function mergeSelected() {
  if (!analysis) return;
  const i = roll.selectedIndex;
  if (i < 0 || notes.length < 2) return;
  const j = i + 1 < notes.length ? i : i - 1;
  const a = notes[j];
  const b = notes[j + 1];
  const la = a.end - a.start;
  const lb = b.end - b.start;
  pushUndo();
  notes.splice(j, 2, {
    start: a.start,
    end: b.end,
    pitch: notePitch(analysis.f0, a.start, b.end),
    shift: (a.shift * la + b.shift * lb) / (la + lb),
  });
  roll.setNotes(notes, j);
  commit();
}

function deleteSelected() {
  const i = roll.selectedIndex;
  if (i < 0) return;
  pushUndo();
  notes.splice(i, 1);
  roll.setNotes(notes, Math.min(i, notes.length - 1));
  commit();
}

function resetSelected() {
  const i = roll.selectedIndex;
  if (i < 0 || notes[i].shift === 0) return;
  pushUndo();
  notes[i].shift = 0;
  commit();
}

/** Move the selected note one step of the scale up or down. */
function nudgeSelected(dir: 1 | -1) {
  const i = roll.selectedIndex;
  if (i < 0) return;
  const n = notes[i];
  const auto = autoShift(n, params);
  const now = n.pitch + auto + n.shift;
  const target = stepInScale(now, dir, params.mask);
  pushUndo();
  n.shift = Math.max(-12, Math.min(12, target - (n.pitch + auto)));
  commit();
}

// ---------- Recording ----------

let recorder: MediaRecorder | null = null;
let recTimer = 0;

async function toggleRecord() {
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    flash("This browser can't record audio.", true);
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    flash('Microphone blocked. Allow access in your browser and try again.', true);
    return;
  }
  stop();
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream);
  recorder = rec;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    window.clearInterval(recTimer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    btn('record').title = 'Record from your microphone';
    btn('record').toggleAttribute('data-recording', false);
    btn('record').selected = false;
    setBusy('Reading recording…');
    try {
      const buf = await audio().decodeAudioData(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer());
      fileName = 'recording';
      await loadBuffer(buf);
    } catch (err) {
      console.error(err);
      setBusy(null);
      flash("Couldn't use that recording.", true);
    }
  };
  rec.start();
  btn('record').title = 'Stop recording';
  btn('record').toggleAttribute('data-recording', true);
  btn('record').selected = true;
  const t0 = performance.now();
  setStatus('Recording… 0:00');
  recTimer = window.setInterval(() => {
    const s = Math.floor((performance.now() - t0) / 1000);
    setStatus(`Recording… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }, 250);
}

// ---------- Buttons ----------

function loadDemo() {
  const a = audio();
  const data = makeDemo(a.sampleRate);
  const buf = a.createBuffer(1, data.length, a.sampleRate);
  buf.copyToChannel(data, 0);
  fileName = 'demo';
  void loadBuffer(buf);
}

const actions: Record<string, () => void> = {
  open: () => fileInput.click(),
  record: () => void toggleRecord(),
  demo: loadDemo,
  export: exportWav,
};
document.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
  if (el.tagName !== 'SP-MENU-ITEM') el.addEventListener('click', () => actions[el.dataset.action!]());
});
// The File menu: Spectrum's action menu reports the item that was chosen.
const fileMenu = field('fileMenu');
fileMenu.addEventListener('change', () => {
  const choice = String(fileMenu.value);
  fileMenu.value = '';
  actions[choice]?.();
});

fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = '';
};

btn('play').onclick = togglePlay;
btn('ab').onclick = () => {
  setBypass(!bypass);
  flash(bypass ? 'Playing the original' : 'Playing the corrected audio');
};
btn('merge').onclick = mergeSelected;
btn('delete').onclick = deleteSelected;
btn('undo').onclick = undo;
btn('redo').onclick = redo;
btn('reset').onclick = () => {
  if (notes.some((n) => n.shift !== 0) || curve.some((v) => v !== 0)) pushUndo();
  for (const n of notes) n.shift = 0;
  curve.fill(0);
  resetControls();
  commit();
};
btn('zoomIn').onclick = () => roll.zoom(1.4);
btn('zoomOut').onclick = () => roll.zoom(1 / 1.4);
btn('fit').onclick = () => roll.fit();

function exportWav() {
  if (!original) return;
  window.clearTimeout(renderTimer);
  render();
  const buf = rendered ?? original;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  const url = URL.createObjectURL(encodeWav(channels, buf.sampleRate));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName}-tuned.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Help ----------

const helpOverlay = $<HTMLElement & { open: boolean }>('helpOverlay');
const toggleHelp = (show = !helpOverlay.open) => (helpOverlay.open = show);
$('helpDialog').addEventListener('close', () => toggleHelp(false));

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  // Keys typed into a field, slider, picker or menu belong to that control.
  const path = e.composedPath();
  const inControl = path.some(
    (el) =>
      el instanceof HTMLElement &&
      /^(INPUT|TEXTAREA|SELECT|SP-NUMBER-FIELD|SP-SLIDER|SP-PICKER|SP-MENU|SP-MENU-ITEM|SP-ACTION-MENU|SP-TEXTFIELD)$/.test(el.tagName),
  );
  if (inControl && e.key !== 'Escape') return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && key === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 'o') {
    e.preventDefault();
    fileInput.click();
  } else if (mod && key === 'e') {
    e.preventDefault();
    exportWav();
  } else if (mod || e.altKey) {
    return;
  } else if (e.code === 'Space') {
    // Let a focused button handle its own Space press.
    if (path.some((el) => el instanceof HTMLElement && /^(BUTTON|SP-ACTION-BUTTON|SP-BUTTON)$/.test(el.tagName))) return;
    e.preventDefault();
    togglePlay();
  } else if (key === '?') {
    toggleHelp();
  } else if (key === 'escape') {
    toggleHelp(false);
    setTool('select');
  } else if (!original) {
    return;
  } else if (key === 'arrowup') {
    e.preventDefault();
    nudgeSelected(1);
  } else if (key === 'arrowdown') {
    e.preventDefault();
    nudgeSelected(-1);
  } else if (key === 'delete') {
    deleteSelected();
  } else if (key === 'backspace') {
    e.preventDefault();
    resetSelected();
  } else if (key === 'c') {
    setTool(roll.tool === 'cut' ? 'select' : 'cut');
  } else if (key === 'v') {
    setTool('select');
  } else if (key === 'p') {
    setTool(roll.tool === 'curve' ? 'select' : 'curve');
  } else if (key === 'g') {
    mergeSelected();
  } else if (key === 'b') {
    btn('ab').click();
  } else if (key === 'home') {
    scrub(0);
    stop();
  } else if (key === '+' || key === '=') {
    roll.zoom(1.4);
  } else if (key === '-' || key === '_') {
    roll.zoom(1 / 1.4);
  } else if (key === '0') {
    roll.fit();
  }
});

// ---------- Drag and drop ----------

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('drag');
});
window.addEventListener('dragleave', () => stage.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('drag');
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});

// The roll draws with Spectrum's colours: read them once the theme's styles are in place.
void customElements.whenDefined('sp-theme').then(async () => {
  const theme = $('theme') as HTMLElement & { updateComplete?: Promise<unknown> };
  await theme.updateComplete;
  roll.palette = paletteFromTheme(theme);
  roll.invalidate();
});

updateButtons();
updateScale();
setPlayhead(0, false);
