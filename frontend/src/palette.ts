// Colours shared by the three.js scenes and the CSS (keep in sync with :root in index.css).

export const CITY = {
  ground: 0x140f2e, // --ink
  body: 0x1a1440, // tower glass, before its neon edges and windows
  plot: 0x1b1540, // file plots, a step up from the ground
  plotEdge: 0x4a3c8c,
  grid: 0x221b4a,
  gridMajor: 0x3a2f6e,
  lit: 0xb18cff, // --lit: the one "lit" colour (selection, active calls)
  unknown: 0xa49cc8,
}

export const KIND_COLORS: Record<string, number> = {
  class: 0xff7aa8, // rose
  method: 0x5fd6f2, // cyan
  function: 0xa3ee7f, // lime
}

export const EDGE_COLORS: Record<string, number> = {
  CALLS: 0xb18cff,
  INHERITS: 0xff7aa8,
  HAS_METHOD: 0x4a3c8c,
}

export const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
