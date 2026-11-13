/** Colours the piano roll draws with. They come from Spectrum's tokens, so the canvas matches the rest of the app. */
export interface Palette {
  font: string;
  bg: string;
  rowDark: string;
  rowLine: string;
  rowLineC: string;
  grid0: string;
  grid1: string;
  grid2: string;
  blob: string;
  ruler: string;
  rulerText: string;
  border: string;
  playhead: string;
  marker: string;
  gutter: string;
  keyBlack0: string;
  keyBlack1: string;
  keyBlackOut: string;
  keyWhite0: string;
  keyWhite1: string;
  keyWhiteOut0: string;
  keyWhiteOut1: string;
  keyEdge: string;
  keyLabel: string;
}

/** Newtone-like tones; the real values live in style.css as --roll-* variables. */
export const defaultPalette: Palette = {
  font: 'system-ui, sans-serif',
  bg: '#27475a',
  rowDark: 'rgba(8,22,30,0.32)',
  rowLine: 'rgba(8,22,30,0.22)',
  rowLineC: 'rgba(8,22,30,0.55)',
  grid0: 'rgba(8,22,30,0.75)',
  grid1: 'rgba(8,22,30,0.4)',
  grid2: 'rgba(8,22,30,0.16)',
  blob: 'rgba(205,228,245,0.88)',
  ruler: '#0f2230',
  rulerText: '#8fb0be',
  border: '#0b1920',
  playhead: 'rgba(225,235,240,0.85)',
  marker: '#f59a3c',
  gutter: '#16262f',
  keyBlack0: '#2b3a43',
  keyBlack1: '#0e171c',
  keyBlackOut: '#18232a',
  keyWhite0: '#f4f7f8',
  keyWhite1: '#c9d2d6',
  keyWhiteOut0: '#9aa5aa',
  keyWhiteOut1: '#7d888d',
  keyEdge: '#7e8b91',
  keyLabel: '#5d6e76',
};

const kebab = (k: string) => k.replace(/[A-Z0-9]/g, (c) => '-' + c.toLowerCase());

/** Read the roll's colours from the --roll-* variables in effect on an element (the <sp-theme>). */
export function paletteFromTheme(el: Element): Palette {
  const cs = getComputedStyle(el);
  const out = { ...defaultPalette };
  for (const key of Object.keys(defaultPalette) as (keyof Palette)[]) {
    const v = cs.getPropertyValue(`--roll-${kebab(key)}`).trim();
    if (v) out[key] = v;
  }
  const font = cs.getPropertyValue('--spectrum-sans-font-family-stack').trim();
  if (font) out.font = font;
  return out;
}
