export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES: Record<string, number[]> = {
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  'Major pentatonic': [0, 2, 4, 7, 9],
  'Minor pentatonic': [0, 3, 5, 7, 10],
};

/** Which of the 12 pitch classes belong to the scale, indexed from C. */
export function scaleMask(key: number, intervals: number[]): boolean[] {
  const mask = new Array<boolean>(12).fill(false);
  for (const iv of intervals) mask[(key + iv) % 12] = true;
  return mask;
}

/** Nearest MIDI note that is in the scale. */
export function snapToScale(pitch: number, mask: boolean[]): number {
  const base = Math.floor(pitch);
  let best = Math.round(pitch);
  let bestDist = Infinity;
  for (let c = base - 6; c <= base + 7; c++) {
    if (!mask[((c % 12) + 12) % 12]) continue;
    const d = Math.abs(c - pitch);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
