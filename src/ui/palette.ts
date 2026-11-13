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

export const defaultPalette: Palette = {
  font: 'system-ui, sans-serif',
  bg: '#1d1d1d',
  rowDark: 'rgba(0,0,0,0.3)',
  rowLine: 'rgba(255,255,255,0.05)',
  rowLineC: 'rgba(255,255,255,0.16)',
  grid0: 'rgba(255,255,255,0.2)',
  grid1: 'rgba(255,255,255,0.1)',
  grid2: 'rgba(255,255,255,0.05)',
  blob: 'rgba(144,144,144,0.5)',
  ruler: '#262626',
  rulerText: '#b2b2b2',
  border: '#3f3f3f',
  playhead: 'rgba(255,255,255,0.9)',
  marker: '#ffffff',
  gutter: '#262626',
  keyBlack0: '#323232',
  keyBlack1: '#1d1d1d',
  keyBlackOut: '#262626',
  keyWhite0: '#ebebeb',
  keyWhite1: '#d1d1d1',
  keyWhiteOut0: '#909090',
  keyWhiteOut1: '#707070',
  keyEdge: '#909090',
  keyLabel: '#545454',
};

function parse(value: string): [number, number, number] | null {
  const m = value.match(/(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Read the Spectrum tokens that are in effect on an element (the <sp-theme>). */
export function paletteFromTheme(el: Element): Palette {
  const cs = getComputedStyle(el);
  const rgb = (name: string, fallback: string) => {
    const c = parse(cs.getPropertyValue(`--spectrum-${name}`));
    return c ? `rgb(${c[0]},${c[1]},${c[2]})` : fallback;
  };
  const rgba = (name: string, a: number, fallback: string) => {
    const c = parse(cs.getPropertyValue(`--spectrum-${name}`));
    return c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : fallback;
  };
  const d = defaultPalette;
  const font = cs.getPropertyValue('--spectrum-sans-font-family-stack').trim() || d.font;
  return {
    font,
    bg: rgb('background-base-color', d.bg),
    rowDark: d.rowDark,
    rowLine: rgba('gray-900', 0.05, d.rowLine),
    rowLineC: rgba('gray-900', 0.16, d.rowLineC),
    grid0: rgba('gray-900', 0.2, d.grid0),
    grid1: rgba('gray-900', 0.1, d.grid1),
    grid2: rgba('gray-900', 0.05, d.grid2),
    blob: rgba('gray-500', 0.5, d.blob),
    ruler: rgb('background-layer-1-color', d.ruler),
    rulerText: rgb('gray-600', d.rulerText),
    border: rgb('gray-200', d.border),
    playhead: rgba('gray-900', 0.9, d.playhead),
    marker: rgb('gray-900', d.marker),
    gutter: rgb('background-layer-1-color', d.gutter),
    keyBlack0: rgb('gray-100', d.keyBlack0),
    keyBlack1: rgb('gray-50', d.keyBlack1),
    keyBlackOut: rgb('gray-75', d.keyBlackOut),
    keyWhite0: rgb('gray-800', d.keyWhite0),
    keyWhite1: rgb('gray-700', d.keyWhite1),
    keyWhiteOut0: rgb('gray-500', d.keyWhiteOut0),
    keyWhiteOut1: rgb('gray-400', d.keyWhiteOut1),
    keyEdge: rgb('gray-500', d.keyEdge),
    keyLabel: rgb('gray-300', d.keyLabel),
  };
}
