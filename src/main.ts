import './style.css';
import { PianoRoll } from './ui/pianoroll';
import { segment, type Note } from './dsp/segment';
import { psola } from './dsp/psola';
import type { Analysis } from './dsp/analyze';
import { encodeWav } from './audio/wav';
import { makeDemo } from './audio/demo';
import { KEY_NAMES, SCALES, scaleMask, snapToScale } from './dsp/scale';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = (id: string) => $<HTMLButtonElement>(id);

const statusEl = $('status');
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
const undoStack: number[][] = [];

let source: AudioBufferSourceNode | null = null;
let playStartedAt = 0;
let playOffset = 0;

const setStatus = (s: string) => (statusEl.textContent = s);

function setEnabled(on: boolean) {
  for (const id of ['play', 'snap', 'reset', 'export']) btn(id).disabled = !on;
  btn('undo').disabled = !on || undoStack.length === 0;
}

// ---------- Loading & analysis ----------

async function loadFile(file: File) {
  stop();
  setStatus(`Decoding ${file.name}…`);
  try {
    const buf = await audio().decodeAudioData(await file.arrayBuffer());
    fileName = file.name.replace(/\.[^.]+$/, '');
    await loadBuffer(buf);
  } catch (err) {
    console.error(err);
    setStatus('Could not read that file.');
  }
}

async function loadBuffer(buf: AudioBuffer) {
  stop();
  setEnabled(false);
  setStatus('Analysing pitch…');
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }

  const result = await new Promise<Analysis>((resolve, reject) => {
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

  original = buf;
  rendered = buf;
  analysis = result;
  notes = segment(result.f0, result.hopSec);
  undoStack.length = 0;
  playOffset = 0;
  $('hint').classList.add('hidden');
  roll.setData(notes, result.f0, result.env, result.hopSec, buf.duration);
  setEnabled(true);
  setStatus(notes.length ? `${notes.length} notes` : 'No pitched notes found.');
}

// ---------- Rendering ----------

function render() {
  if (!original || !analysis) return;
  if (notes.every((n) => n.shift === 0)) {
    rendered = original;
    return;
  }
  const { f0, hopSec, marks } = analysis;
  const sr = original.sampleRate;

  // Per-frame shift in semitones, lightly smoothed so note edges glide.
  const shift = new Float32Array(f0.length);
  for (const n of notes) shift.fill(n.shift, n.start, n.end);
  const ratio = new Float32Array(f0.length);
  const R = 4; // ~20 ms glide at note edges
  for (let i = 0; i < f0.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      if (j >= 0 && j < f0.length) {
        s += shift[j];
        c++;
      }
    }
    ratio[i] = Math.pow(2, s / c / 12);
  }
  const framesPerSample = 1 / (sr * hopSec);
  const last = f0.length - 1;
  const ratioAt = (sample: number) => ratio[Math.min(last, Math.round(sample * framesPerSample))];

  const out = audio().createBuffer(original.numberOfChannels, original.length, sr);
  for (let c = 0; c < original.numberOfChannels; c++) {
    out.copyToChannel(psola(original.getChannelData(c), marks, ratioAt), c);
  }
  rendered = out;
}

// ---------- Playback ----------

const isPlaying = () => source !== null;

function currentTime() {
  if (!isPlaying()) return playOffset;
  return Math.min(rendered!.duration, playOffset + audio().currentTime - playStartedAt);
}

function play() {
  if (!rendered) return;
  const a = audio();
  void a.resume();
  if (playOffset >= rendered.duration - 0.01) playOffset = 0;
  const node = a.createBufferSource();
  node.buffer = rendered;
  node.connect(a.destination);
  node.onended = () => {
    if (source !== node) return;
    source = null;
    playOffset = 0;
    btn('play').textContent = 'Play';
    roll.setPlayhead(0, false);
  };
  node.start(0, playOffset);
  playStartedAt = a.currentTime;
  source = node;
  btn('play').textContent = 'Stop';
}

function stop() {
  if (!source) return;
  playOffset = currentTime();
  const node = source;
  source = null;
  node.onended = null;
  node.stop();
  btn('play').textContent = 'Play';
}

// Dragging the playhead pauses playback and resumes from the new spot on release.
let resumeAfterScrub = false;

function scrubStart() {
  resumeAfterScrub = isPlaying();
  stop();
}

function scrub(t: number) {
  playOffset = t;
  roll.setPlayhead(t, false);
}

function scrubEnd() {
  if (resumeAfterScrub) play();
  resumeAfterScrub = false;
}

function tick() {
  if (isPlaying()) roll.setPlayhead(currentTime(), true);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Editing ----------

function pushUndo() {
  undoStack.push(notes.map((n) => n.shift));
  if (undoStack.length > 100) undoStack.shift();
  btn('undo').disabled = false;
}

function commit() {
  const was = isPlaying();
  stop();
  render();
  roll.invalidate();
  if (was) play();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  notes.forEach((n, i) => (n.shift = prev[i]));
  btn('undo').disabled = undoStack.length === 0;
  commit();
}

// ---------- Scale ----------

const keySel = $<HTMLSelectElement>('key');
const scaleSel = $<HTMLSelectElement>('scale');
KEY_NAMES.forEach((name, i) => keySel.add(new Option(name, String(i))));
Object.keys(SCALES).forEach((name) => scaleSel.add(new Option(name, name)));
let mask = scaleMask(0, SCALES.Chromatic);

function updateScale() {
  mask = scaleMask(Number(keySel.value), SCALES[scaleSel.value]);
  keySel.disabled = scaleSel.value === 'Chromatic';
  roll.scale = mask;
  roll.snap = (p) => snapToScale(p, mask);
  roll.invalidate();
}
keySel.onchange = updateScale;
scaleSel.onchange = updateScale;
updateScale();

roll.onEditStart = pushUndo;
roll.onEdit = commit;
roll.onSeekStart = scrubStart;
roll.onSeek = scrub;
roll.onSeekEnd = scrubEnd;

// ---------- UI wiring ----------

btn('open').onclick = () => fileInput.click();
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = '';
};

btn('demo').onclick = () => {
  const a = audio();
  const data = makeDemo(a.sampleRate);
  const buf = a.createBuffer(1, data.length, a.sampleRate);
  buf.copyToChannel(data, 0);
  fileName = 'demo';
  void loadBuffer(buf);
};

btn('play').onclick = () => (isPlaying() ? stop() : play());

btn('snap').onclick = () => {
  pushUndo();
  for (const n of notes) n.shift = snapToScale(n.pitch, mask) - n.pitch;
  commit();
};

btn('reset').onclick = () => {
  if (notes.every((n) => n.shift === 0)) return;
  pushUndo();
  for (const n of notes) n.shift = 0;
  commit();
};

btn('undo').onclick = undo;

btn('export').onclick = () => {
  if (!rendered) return;
  const channels: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(rendered.getChannelData(c));
  const url = URL.createObjectURL(encodeWav(channels, rendered.sampleRate));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName}-tuned.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (rendered) isPlaying() ? stop() : play();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
});

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
