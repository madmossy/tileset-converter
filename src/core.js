/* Tileset Converter — the conversion core.
 *
 * Every autotile layout, dual grid or blob, is built from the same small set
 * of quarter-tile PIECES. A piece is one quarter of one terrain cell, and how
 * it looks depends only on three of that cell's neighbours: the one above or
 * below it, the one beside it, and the one diagonally out from its corner.
 *
 *   blob tile — sits ON a terrain cell; its four quarters are that cell's own.
 *   dual tile — sits where four cells MEET; each quarter is the nearest quarter
 *               of a different cell, so a dual tile can also show the parts of
 *               a filled cell's edge that spill over into an empty neighbour.
 *
 * So reading any layout means cutting it into pieces and naming each one, and
 * writing any layout means gluing named pieces back together.
 *
 * Nothing here touches the DOM: the web page, the CLI and the tests share it.
 * Images are { width, height, data: Uint8ClampedArray } in RGBA order.
 */

// ---------------------------------------------------------------------------
// Pieces

/** Quarter positions inside a tile: bit 0 = right half, bit 1 = bottom half. */
export const POSITION_NAMES = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** Pieces of a FILLED cell, named by which of the three neighbours are open. */
export const FILLED_KINDS = ['fill', 'outer', 'hedge', 'vedge', 'inner'];
/** Pieces of an EMPTY cell next to filled ones: the art that overhangs into it.
 *  Named b + (vertical, horizontal, diagonal neighbour filled). */
export const OVERHANG_KINDS = ['b100', 'b010', 'b001', 'b110', 'b101', 'b011', 'b111'];
/** The piece of an EMPTY cell with nothing filled nearby: whatever the terrain
 *  sits on. See-through art leaves it blank; art on a solid background (grass
 *  on water, say) shows that background here. */
export const EMPTY_KIND = 'empty';
export const ALL_KINDS = [...FILLED_KINDS, ...OVERHANG_KINDS, EMPTY_KIND];

export const KIND_NAMES = {
  fill: 'Fill',
  outer: 'Outer corner',
  hedge: 'Top / bottom edge',
  vedge: 'Side edge',
  inner: 'Inner corner',
  b100: 'Overhang from a corner above or below',
  b010: 'Overhang from a corner beside',
  b001: 'Overhang from a diagonal corner',
  b110: 'Overhang from two corners',
  b101: 'Overhang from an edge above or below',
  b011: 'Overhang from an edge beside',
  b111: 'Overhang into an inner corner',
  empty: 'Background, away from the terrain',
};

/** The piece a quarter shows, from its own cell and three neighbours. */
export function pieceKind(filled, vertical, horizontal, diagonal) {
  if (filled) {
    if (!vertical && !horizontal) return 'outer';
    if (!vertical) return 'hedge';
    if (!horizontal) return 'vedge';
    if (!diagonal) return 'inner';
    return 'fill';
  }
  if (!vertical && !horizontal && !diagonal) return EMPTY_KIND;
  return 'b' + (vertical ? 1 : 0) + (horizontal ? 1 : 0) + (diagonal ? 1 : 0);
}

/** A set of pieces for one tileset: position (0-3) x kind -> pixels. */
export class Pieces {
  constructor(half) {
    this.half = half;
    this.map = new Map();
  }

  get(pos, kind) {
    return this.map.get(pos + ':' + kind) || null;
  }

  set(pos, kind, piece) {
    this.map.set(pos + ':' + kind, piece);
  }

  /** Keep the first example of each piece; later ones are ignored. */
  offer(pos, kind, pixels, from) {
    if (!this.get(pos, kind)) this.set(pos, kind, { pixels, how: 'found', from });
  }
}

// ---------------------------------------------------------------------------
// Recipes: which piece goes in each quarter of a tile

/** Blob neighbour bits, clockwise from the top. */
export const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;
const DIRECTIONS = [['N', N], ['NE', NE], ['E', E], ['SE', SE], ['S', S], ['SW', SW], ['W', W], ['NW', NW]];
const OFFSETS = [[N, 0, -1], [NE, 1, -1], [E, 1, 0], [SE, 1, 1], [S, 0, 1], [SW, -1, 1], [W, -1, 0], [NW, -1, -1]];
/** Per quarter position: [vertical, horizontal, diagonal] neighbour bit. */
const QUARTER_BITS = [[N, W, NW], [N, E, NE], [S, W, SW], [S, E, SE]];

/** Drop corner bits whose two sides aren't both filled: they can't change the tile. */
export function canonicalMask(mask) {
  let m = mask & 255;
  if (!(m & N) || !(m & E)) m &= ~NE;
  if (!(m & S) || !(m & E)) m &= ~SE;
  if (!(m & S) || !(m & W)) m &= ~SW;
  if (!(m & N) || !(m & W)) m &= ~NW;
  return m;
}

/** The 47 distinct blob neighbourhoods, ascending. */
export function blobMasks() {
  const seen = new Set();
  for (let m = 0; m < 256; m++) seen.add(canonicalMask(m));
  return [...seen].sort((a, b) => a - b);
}

/** A blob tile for a filled cell with neighbours `mask`. */
export function blobRecipe(mask) {
  return QUARTER_BITS.map(([v, h, d], q) => ({ pos: q, kind: pieceKind(true, mask & v, mask & h, mask & d) }));
}

/** Dual-grid corner bits: which of the four cells meeting under the tile are filled. */
export const TL = 1, TR = 2, BL = 4, BR = 8;

/** A dual tile. Quarter q shows the corner cell q's quarter nearest the middle,
 *  which is that cell's opposite quarter (3 - q). */
export function dualRecipe(corners) {
  const c = [0, 1, 2, 3].map((i) => (corners >> i) & 1);
  return [0, 1, 2, 3].map((q) => ({ pos: 3 - q, kind: pieceKind(c[q], c[q ^ 2], c[q ^ 1], c[q ^ 3]) }));
}

/** Four side bits (top 1, right 2, bottom 4, left 8) as a blob mask, with each
 *  corner filled wherever both of its sides are: Match Sides has no inner corners. */
export function sidesMask(sides) {
  let m = 0;
  if (sides & 1) m |= N;
  if (sides & 2) m |= E;
  if (sides & 4) m |= S;
  if (sides & 8) m |= W;
  return canonicalMask(m | NE | SE | SW | NW);
}

function sidesOf(mask) {
  return (mask & N ? 1 : 0) | (mask & E ? 2 : 0) | (mask & S ? 4 : 0) | (mask & W ? 8 : 0);
}

/** Neighbour mask of cell (x, y), given filled(x, y). */
export function maskAt(filled, x, y) {
  let m = 0;
  for (const [bit, dx, dy] of OFFSETS) if (filled(x + dx, y + dy)) m |= bit;
  return m;
}

// ---------------------------------------------------------------------------
// Layouts

function fromRows(rows) {
  const slots = [];
  rows.forEach((row, y) => row.forEach((key, x) => {
    if (key !== null) slots.push({ x, y, key });
  }));
  return slots;
}

/** jess::codes' dual-grid sheet, as its Godot ports lay it out (keys = corner bits).
 *  Neighbouring tiles share corners, so the sheet reads as one picture. */
const DUAL_STANDARD = [
  [4, 10, 13, 12],
  [9, 14, 15, 7],
  [2, 3, 11, 5],
  [0, 8, 6, 1],
];

/** Godot's 3x3-minimal blob template (keys = neighbour masks), read from its
 *  colour-coded template image. One slot (10,1) is unused. */
const BLOB_GODOT = [
  [16, 20, 84, 80, 213, 92, 116, 87, 28, 125, 124, 112],
  [17, 21, 85, 81, 29, 127, 253, 113, 31, 119, null, 245],
  [1, 5, 69, 65, 23, 223, 247, 209, 95, 255, 221, 241],
  [0, 4, 68, 64, 117, 71, 197, 93, 7, 199, 215, 193],
];

/** A lone tile, the four inner corners, and a 2x2 block (RPG Maker's A2 shape). */
const MINIMAL = [
  [0, N | E | S | W],
  [E | SE | S, S | SW | W],
  [N | NE | E, N | W | NW],
];

function ringRows() {
  const inRing = (x, y) => x >= 0 && y >= 0 && x < 3 && y < 3 && !(x === 1 && y === 1);
  const rows = [0, 1, 2].map((y) => [0, 1, 2].map((x) => (inRing(x, y) ? maskAt(inRing, x, y) : null)));
  return [...rows, [null, null, null], [null, 255, null]];
}

export const LAYOUTS = [
  {
    id: 'dual-standard',
    family: 'dual',
    godot: 'corners',
    paintable: true,
    name: 'Dual grid · standard 4×4',
    file: 'dual_4x4',
    blurb: 'The usual dual-grid sheet: the layout from jess::codes’ dual-grid tutorial and its Godot ports. Neighbouring tiles share corners, so the whole sheet reads as one picture.',
    cols: 4,
    rows: 4,
    slots: fromRows(DUAL_STANDARD),
  },
  {
    id: 'dual-binary',
    family: 'dual',
    godot: 'corners',
    paintable: true,
    name: 'Dual grid · 4×4 by number',
    file: 'dual_numbered',
    blurb: 'Tile n sits at column n % 4, row n / 4, where n = top-left + 2 × top-right + 4 × bottom-left + 8 × bottom-right. Handy when your own script picks the tile.',
    cols: 4,
    rows: 4,
    slots: [...Array(16).keys()].map((n) => ({ x: n % 4, y: n >> 2, key: n })),
  },
  {
    id: 'blob-godot',
    family: 'blob',
    godot: 'corners-and-sides',
    paintable: true,
    name: 'Blob 47 · Godot 12×4 template',
    file: 'blob_12x4',
    blurb: 'Godot’s classic 3×3-minimal template, for a Match Corners and Sides terrain. Blob tiles sit on the grid, so art that overhangs a cell’s edge gets trimmed.',
    cols: 12,
    rows: 4,
    slots: fromRows(BLOB_GODOT),
  },
  {
    id: 'blob-sorted',
    family: 'blob',
    godot: 'corners-and-sides',
    paintable: true,
    name: 'Blob 47 · sorted 8-column',
    file: 'blob_8col',
    blurb: 'The same 47 tiles sorted by neighbour mask (N = 1, NE = 2, E = 4 … NW = 128), 8 to a row, with the last slot left empty. Easy to index from your own code: slot i holds the i-th mask.',
    cols: 8,
    rows: 6,
    slots: blobMasks().map((key, i) => ({ x: i % 8, y: i >> 3, key })),
  },
  {
    id: 'sides-16',
    family: 'blob',
    godot: 'sides',
    paintable: true,
    name: 'Match Sides · 4×4',
    file: 'sides_4x4',
    blurb: 'Godot’s Match Sides terrain: 16 tiles that only look at their four sides, so there are no inner corners. Tile n: n = top + 2 × right + 4 × bottom + 8 × left.',
    cols: 4,
    rows: 4,
    slots: [...Array(16).keys()].map((n) => ({ x: n % 4, y: n >> 2, key: sidesMask(n) })),
  },
  {
    id: 'minimal',
    family: 'blob',
    godot: null,
    paintable: false,
    name: 'Minimal 6-tile · RPG Maker A2 style',
    file: 'minimal_2x3',
    blurb: 'A lone tile, the four inner corners, and a 2×2 block. That’s enough to build every other layout here, so it’s a quick sheet to draw by hand.',
    cols: 2,
    rows: 3,
    slots: fromRows(MINIMAL),
  },
  {
    id: 'ring',
    family: 'blob',
    godot: null,
    paintable: false,
    name: '3×3 ring + fill · source block',
    file: 'ring_3x3',
    blurb: 'A 3×3 block with a hole in the middle, and a fill tile below it. The ring holds every edge and outer corner and the hole every inner corner, so it’s another quick sheet to draw by hand.',
    cols: 3,
    rows: 5,
    slots: fromRows(ringRows()),
  },
];

export function layoutById(id) {
  return LAYOUTS.find((l) => l.id === id) || null;
}

export function recipeFor(layout, key) {
  return layout.family === 'dual' ? dualRecipe(key) : blobRecipe(key);
}

/** key -> slot, for looking a tile up while painting. */
export function slotIndex(layout) {
  const index = new Map();
  for (const slot of layout.slots) if (!index.has(slot.key)) index.set(slot.key, slot);
  return index;
}

/** A plain-English description of a slot, for hover text. */
export function describeSlot(layout, key) {
  if (layout.family === 'dual') {
    const names = POSITION_NAMES.filter((_, i) => (key >> i) & 1);
    if (!names.length) return 'No filled corners: the empty tile';
    if (names.length === 4) return 'All four corners filled';
    return 'Filled corners: ' + names.join(', ');
  }
  const dirs = DIRECTIONS.filter(([, bit]) => key & bit).map(([name]) => name);
  return dirs.length ? 'Filled neighbours: ' + dirs.join(' ') : 'No filled neighbours: a lone tile';
}

// ---------------------------------------------------------------------------
// Image helpers

export function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Fraction of a rectangle's on-image pixels that are opaque (alpha >= 128). */
export function coverage(img, x, y, w, h) {
  let on = 0;
  let total = 0;
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(img.width, x + w), y1 = Math.min(img.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      total++;
      if (img.data[(yy * img.width + xx) * 4 + 3] >= 128) on++;
    }
  }
  return total ? on / total : 0;
}

function crop(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const sy = y + yy;
    if (sy < 0 || sy >= img.height) continue;
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      out.set(img.data.subarray(si, si + 4), (yy * w + xx) * 4);
    }
  }
  return out;
}

/** Copy a w x h block of pixels into img at (x, y), clipped to the image. */
function paste(pixels, w, h, img, x, y) {
  for (let yy = 0; yy < h; yy++) {
    const dy = y + yy;
    if (dy < 0 || dy >= img.height) continue;
    for (let xx = 0; xx < w; xx++) {
      const dx = x + xx;
      if (dx < 0 || dx >= img.width) continue;
      const si = (yy * w + xx) * 4;
      img.data.set(pixels.subarray(si, si + 4), (dy * img.width + dx) * 4);
    }
  }
}

/** Copy a region of one image into another, clipped. */
export function blitRegion(src, sx, sy, w, h, dst, dx, dy) {
  paste(crop(src, sx, sy, w, h), w, h, dst, dx, dy);
}

function flip(pixels, size, flipX, flipY) {
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = flipX ? size - 1 - x : x;
      const sy = flipY ? size - 1 - y : y;
      const si = (sy * size + sx) * 4;
      out.set(pixels.subarray(si, si + 4), (y * size + x) * 4);
    }
  }
  return out;
}

/** Later layers drawn over earlier ones wherever they have a visible pixel.
 *  For art on a solid background, `base` is the background piece: there a
 *  layer only shows where it isn't plain background, and where two layers
 *  both show something, the one further from the background wins (the part
 *  of a shoreline nearer the land, say). */
function layer(list, base = null) {
  const out = list[0].slice();
  for (const top of list.slice(1)) {
    for (let i = 0; i < top.length; i += 4) {
      if (top[i + 3] === 0) continue;
      if (base && pixelDistance2(top, base, i) <= pixelDistance2(out, base, i)) continue;
      out.set(top.subarray(i, i + 4), i);
    }
  }
  return out;
}

function pixelDistance2(a, b, i) {
  return (a[i] - b[i]) ** 2 + (a[i + 1] - b[i + 1]) ** 2 + (a[i + 2] - b[i + 2]) ** 2 + (a[i + 3] - b[i + 3]) ** 2;
}

function solid(size, rgba) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < out.length; i += 4) out.set(rgba, i);
  return out;
}

export function hasTransparency(img) {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true;
  return false;
}

/** The commonest colour around the image's border: usually the background. */
export function borderColour(img) {
  const counts = new Map();
  const add = (x, y) => {
    const i = (y * img.width + x) * 4;
    const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < img.width; x++) { add(x, 0); add(x, img.height - 1); }
  for (let y = 0; y < img.height; y++) { add(0, y); add(img.width - 1, y); }
  let best = 0, bestCount = -1;
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

/** A copy of img with every pixel of colour `rgb` made transparent. */
export function keyOut(img, rgb) {
  const out = { width: img.width, height: img.height, data: img.data.slice() };
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i] === rgb[0] && out.data[i + 1] === rgb[1] && out.data[i + 2] === rgb[2]) out.data[i + 3] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a source image

/** How the image's grid is read. */
export const READ_MODES = [
  { id: 'auto', name: 'Work it out for me' },
  { id: 'dual', name: 'Dual-grid tiles, in any arrangement' },
  { id: 'terrain', name: 'A drawing of terrain on the grid' },
];

const SIZES = [8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 256];

function candidateSizes(w, h) {
  const exact = SIZES.filter((t) => w % t === 0 && h % t === 0 && (w / t) * (h / t) >= 4);
  if (exact.length) return exact;
  return SIZES.filter((t) => Math.floor(w / t) * Math.floor(h / t) >= 1);
}

/** Where a reading looks to decide whether a cell is filled, as [x, y, side]
 *  squares within a tile: a dual tile's four corners (each the middle of a
 *  terrain cell, as far from that cell's edges as you can get), or the middle
 *  of a drawn cell. See-through art fades out past its edge, but art on a
 *  solid background doesn't: a shoreline can reach most of the way to a
 *  cell's middle. So a colour reading looks at smaller squares, right at the corner. */
function sampleSpots(t, mode, split) {
  if (mode === 'dual') {
    const s = Math.max(1, t >> (split ? 3 : 2));
    return [[0, 0, s], [t - s, 0, s], [0, t - s, s], [t - s, t - s, s]];
  }
  const m = t >> 2;
  return [[m, m, t - 2 * m]];
}

/** A dual tile's corner bits, read from the squares at its four corners.
 *  `fillMap` is the image, or for art on a solid background its filledMap. */
export function dualCornersAt(fillMap, x0, y0, t, split = null) {
  let key = 0;
  sampleSpots(t, 'dual', split).forEach(([dx, dy, s], i) => {
    if (coverage(fillMap, x0 + dx, y0 + dy, s, s) >= 0.5) key |= 1 << i;
  });
  return key;
}

function cellFilled(fillMap, x0, y0, t) {
  const [[dx, dy, s]] = sampleSpots(t, 'terrain', null);
  return coverage(fillMap, x0 + dx, y0 + dy, s, s) >= 0.5;
}

/** How far from clean on/off the sampled spots are: 0 = every spot clearly
 *  full or clearly empty. */
function ambiguity(img, fillMap, t, mode, split) {
  const cols = Math.floor(img.width / t), rows = Math.floor(img.height / t);
  const spots = sampleSpots(t, mode, split);
  let sum = 0, count = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = x * t, y0 = y * t;
      if (coverage(img, x0, y0, t, t) === 0) continue;
      for (const [dx, dy, s] of spots) {
        const c = coverage(fillMap, x0 + dx, y0 + dy, s, s);
        sum += Math.min(c, 1 - c);
        count++;
      }
    }
  }
  return count ? sum / count : null;
}

// ---------------------------------------------------------------------------
// Terrain on a solid background

function distance2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Mean colour of a square's pixels, or null if any of them is see-through. */
function meanColour(img, x, y, s) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + s); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + s); xx++) {
      const i = (yy * img.width + xx) * 4;
      if (img.data[i + 3] < 128) return null;
      sum[0] += img.data[i];
      sum[1] += img.data[i + 1];
      sum[2] += img.data[i + 2];
      n++;
    }
  }
  return n ? sum.map((v) => v / n) : null;
}

/** Split colours into the two groups that sit tightest around their own means,
 *  starting from the two colours furthest apart. Returns { a, b, spread }, the
 *  means and the RMS distance of each colour from its group's mean. */
function twoMeans(colours) {
  const furthest = (from) => colours.reduce((best, c) => (distance2(c, from) > distance2(best, from) ? c : best));
  let b = furthest(colours[0]);
  let a = furthest(b);
  let spread = 0;
  for (let round = 0; round < 16; round++) {
    const sums = [[0, 0, 0, 0], [0, 0, 0, 0]];
    let within = 0;
    for (const c of colours) {
      const da = distance2(c, a), db = distance2(c, b);
      const sum = sums[da <= db ? 0 : 1];
      for (let k = 0; k < 3; k++) sum[k] += c[k];
      sum[3]++;
      within += Math.min(da, db);
    }
    spread = Math.sqrt(within / colours.length);
    if (!sums[0][3] || !sums[1][3]) return null;
    const [na, nb] = sums.map((sum) => sum.slice(0, 3).map((v) => v / sum[3]));
    if (distance2(na, a) < 0.01 && distance2(nb, b) < 0.01) break;
    a = na;
    b = nb;
  }
  return { a, b, spread };
}

/** Art drawn on a solid background (grass on water, say) has no see-through
 *  pixels to tell filled from empty, so tell them apart by colour instead. If
 *  every sample spot on the tiles is solid and the spots fall into two clearly
 *  different colours, returns those two colours; otherwise null. */
function colourSplit(img, t, mode) {
  const cols = Math.floor(img.width / t), rows = Math.floor(img.height / t);
  const spots = sampleSpots(t, mode, true);
  const colours = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (coverage(img, x * t, y * t, t, t) === 0) continue;
      for (const [dx, dy, s] of spots) {
        const c = meanColour(img, x * t + dx, y * t + dy, s);
        if (!c) return null;
        colours.push(c);
      }
    }
  }
  if (colours.length < 2) return null;
  const groups = twoMeans(colours);
  if (!groups) return null;
  const gap = Math.sqrt(distance2(groups.a, groups.b));
  return gap >= 48 && gap >= 4 * groups.spread ? [groups.a, groups.b] : null;
}

/** A copy of img whose alpha says which pixels are terrain: the solid ones
 *  nearer the terrain colour than the background colour. */
function filledMap(img, split) {
  const out = createImage(img.width, img.height);
  const d = img.data;
  const [tr, tg, tb] = split.terrain, [br, bg, bb] = split.background;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const toTerrain = (d[i] - tr) ** 2 + (d[i + 1] - tg) ** 2 + (d[i + 2] - tb) ** 2;
    const toBackground = (d[i] - br) ** 2 + (d[i + 1] - bg) ** 2 + (d[i + 2] - bb) ** 2;
    if (toTerrain < toBackground) out.data[i + 3] = 255;
  }
  return out;
}

/** Which of two colours is the terrain: the one that spills over into the
 *  other's cells, the way edge art (an outline, a shoreline) overhangs from a
 *  filled cell into an empty one. Returns { terrain, background }. */
function orient(img, t, mode, [a, b]) {
  const inA = filledMap(img, { terrain: a, background: b });
  const inB = filledMap(img, { terrain: b, background: a });
  const cols = Math.floor(img.width / t), rows = Math.floor(img.height / t);
  const spots = sampleSpots(t, mode, true);
  const h = t >> 1;
  // Per group: how many quarters belong to its cells, and how much of the
  // other colour they hold between them.
  const cells = [0, 0], spilt = [0, 0];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = x * t, y0 = y * t;
      if (coverage(img, x0, y0, t, t) === 0) continue;
      for (let q = 0; q < 4; q++) {
        const [dx, dy, s] = spots[mode === 'dual' ? q : 0];
        const group = coverage(inA, x0 + dx, y0 + dy, s, s) >= 0.5 ? 0 : 1;
        const qx = x0 + (q & 1) * h, qy = y0 + (q >> 1) * h;
        cells[group]++;
        spilt[group] += coverage(group ? inA : inB, qx, qy, h, h);
      }
    }
  }
  // Compare rates: B's cells hold more of A per quarter than A's hold of B.
  const aSpills = spilt[1] * cells[0] >= spilt[0] * cells[1];
  return aSpills ? { terrain: a, background: b } : { terrain: b, background: a };
}

// ---------------------------------------------------------------------------
// Scoring a reading

/** True if two pixels look different: one shows and the other doesn't, or
 *  both show in clearly different colours. */
function differs(a, i, b, j) {
  const aOn = a[i + 3] >= 128, bOn = b[j + 3] >= 128;
  if (aOn !== bOn) return true;
  if (!aOn) return false;
  return Math.abs(a[i] - b[j]) > 48 || Math.abs(a[i + 1] - b[j + 1]) > 48 || Math.abs(a[i + 2] - b[j + 2]) > 48;
}

/** How badly a grid reading explains the image; lower is better. It adds up:
 *   - ambiguity: sample spots that are neither clearly full nor clearly empty;
 *   - contradiction: quarters called filled that are mostly empty, or the reverse;
 *   - rebuild error: pixels that come out wrong when every tile is rebuilt from
 *     the one example of each piece the reading kept.
 *  A clean image also reads cleanly on a finer grid, and a tidy dual sheet can
 *  pass for a coarser one; the rebuild and contradiction terms catch the second.
 *  `split` is null to read filled cells from what's see-through, or the
 *  { terrain, background } colours to read them from colour. */
function readingScore(img, t, mode, split) {
  const fillMap = split ? filledMap(img, split) : img;
  const amb = ambiguity(img, fillMap, t, mode, split);
  if (amb === null) return null;
  const { pieces, placements } = extract(img, t, mode, { split, fillMap });
  const h = t >> 1;
  const rebuilt = createImage(t, t);
  let quarters = 0, contradiction = 0, pixels = 0, wrong = 0;
  for (const { x0, y0, recipe } of placements) {
    recipe.forEach((part, q) => {
      const cov = coverage(fillMap, x0 + (q & 1) * h, y0 + (q >> 1) * h, h, h);
      const filled = FILLED_KINDS.includes(part.kind);
      contradiction += filled ? Math.max(0, 0.5 - cov) : Math.max(0, cov - 0.5);
      quarters++;
    });
    rebuilt.data.fill(0);
    drawTile(rebuilt, pieces, recipe, 0, 0, t);
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        pixels++;
        if (differs(img.data, ((y0 + y) * img.width + x0 + x) * 4, rebuilt.data, (y * t + x) * 4)) wrong++;
      }
    }
  }
  if (!quarters) return null;
  return amb + contradiction / quarters + wrong / pixels;
}

// ---------------------------------------------------------------------------
// Choosing a reading

/** Guess the tile size and grid reading: of the readings that score within a
 *  whisker of the best, the one with the biggest tiles, since a finer grid can
 *  always explain an image by cutting real tiles into smaller ones. Each size
 *  is tried reading filled cells from transparency and, when the tiles are
 *  solid, from colour. `split` in the result is null or { terrain, background }. */
export function detect(img, { mode = null, tileSize = 0 } = {}) {
  const sizes = tileSize ? [tileSize] : candidateSizes(img.width, img.height);
  const modes = mode ? [mode] : ['dual', 'terrain'];
  const results = [];
  for (const t of sizes) {
    if (t < 2 || t % 2) continue;
    for (const m of modes) {
      const colours = colourSplit(img, t, m);
      for (const split of colours ? [null, orient(img, t, m, colours)] : [null]) {
        const score = readingScore(img, t, m, split);
        if (score !== null) results.push({ mode: m, tileSize: t, split, score });
      }
    }
  }
  if (!results.length) return null;
  const best = Math.min(...results.map((r) => r.score));
  const close = results.filter((r) => r.score <= best + 0.02);
  close.sort((a, b) => b.tileSize - a.tileSize || a.score - b.score);
  return { ...close[0], results };
}

/** For an image with no see-through pixels: whether its border colour `rgb`
 *  is a backdrop to make see-through. Not when the image reads as terrain on
 *  a solid background and that colour is the terrain's own, since keying it
 *  out would erase the terrain. */
export function isBackdrop(img, rgb) {
  const found = detect(img);
  if (!found || !found.split) return true;
  return distance2(rgb, found.split.background) <= distance2(rgb, found.split.terrain);
}

/** Cut an image into pieces, reading its grid as `mode` ('dual' or 'terrain')
 *  or as `layout`'s slots. Filled cells are read from `fillMap`: the image, or
 *  its filledMap for art on a solid background. Returns the pieces, the tiles
 *  it found, and every tile's recipe with its position (placements), for
 *  checking the reading. */
function extract(img, t, mode, { layout = null, split = null, fillMap = img } = {}) {
  const pieces = new Pieces(t >> 1);
  const placements = [];
  const tiles = [];
  const take = (recipe, x0, y0, from) => {
    placements.push({ x0, y0, recipe });
    const h = t >> 1;
    recipe.forEach((part, q) => {
      pieces.offer(part.pos, part.kind, crop(img, x0 + (q & 1) * h, y0 + (q >> 1) * h, h, h), { ...from, q });
    });
  };
  const cols = Math.floor(img.width / t), rows = Math.floor(img.height / t);
  if (layout) {
    for (const slot of layout.slots) {
      tiles.push({ ...slot });
      take(recipeFor(layout, slot.key), slot.x * t, slot.y * t, { x: slot.x, y: slot.y });
    }
  } else if (mode === 'dual') {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (coverage(img, x * t, y * t, t, t) === 0) continue;
        const key = dualCornersAt(fillMap, x * t, y * t, t, split);
        tiles.push({ x, y, key });
        take(dualRecipe(key), x * t, y * t, { x, y });
      }
    }
  } else {
    const grid = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) grid.push(cellFilled(fillMap, x * t, y * t, t));
    const filled = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const on = filled(x, y);
        const mask = maskAt(filled, x, y);
        if (!on && !mask && coverage(img, x * t, y * t, t, t) === 0) continue;
        if (on) tiles.push({ x, y, key: mask });
        // A lone tile that's terrain all over is a fill swatch, not an island.
        const swatch = on && mask === 0 && coverage(fillMap, x * t, y * t, t, t) === 1;
        const recipe = QUARTER_BITS.map(([v, hb, d], q) => ({ pos: q, kind: swatch ? 'fill' : pieceKind(on, mask & v, mask & hb, mask & d) }));
        take(recipe, x * t, y * t, { x, y });
      }
    }
  }
  return { pieces, tiles, placements };
}

/** Read a source image into pieces.
 *  `read` is 'auto', 'dual', 'terrain' or a layout id; `tileSize` 0 = work it out.
 *  For art on a solid background, `swap` swaps which colour is the terrain.
 *  Returns { read, tileSize, pieces, tiles, cols, rows, split } or throws a
 *  readable Error. `split` is null, or the { terrain, background } colours
 *  when filled cells were told apart by colour. */
export function readSource(img, { read = 'auto', tileSize = 0, swap = false } = {}) {
  let t = tileSize;
  let mode = read;
  let split = null;
  const layout = layoutById(read);
  if (layout) {
    t = t || Math.floor(img.width / layout.cols);
    if (img.width < layout.cols * t || img.height < layout.rows * t) {
      throw new Error(`This layout is ${layout.cols}×${layout.rows} tiles, so a ${t}px tile size needs an image at least ${layout.cols * t}×${layout.rows * t}. Yours is ${img.width}×${img.height}.`);
    }
  } else {
    const found = detect(img, { mode: read === 'auto' ? null : read, tileSize: t });
    if (!found) throw new Error('Couldn’t find any tiles. Is the image empty, or is the tile size bigger than the image?');
    mode = found.mode;
    t = found.tileSize;
    split = found.split;
    if (split && swap) split = { terrain: split.background, background: split.terrain };
  }
  if (t < 2 || t % 2) throw new Error(`The tile size has to be an even number of pixels (got ${t}), because every tile is cut into quarters.`);
  const { pieces, tiles } = extract(img, t, mode, { layout, split, fillMap: split ? filledMap(img, split) : img });
  completePieces(pieces);
  return { read: mode, tileSize: t, pieces, tiles, cols: Math.floor(img.width / t), rows: Math.floor(img.height / t), split };
}

// ---------------------------------------------------------------------------
// Picking tiles by hand

function islandSlots() {
  // A 3x3 island (outer corners, edges and fill), and beside it the four
  // cells around a one-cell hole in solid terrain (the inner corners).
  const island = (x, y) => x >= 0 && y >= 0 && x < 3 && y < 3;
  const holed = (x, y) => !(x === 1 && y === 1);
  const slots = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) slots.push({ x, y, key: maskAt(island, x, y) });
  for (const [x, y] of [[0, 0], [2, 0], [0, 2], [2, 2]]) slots.push({ x: 3 + (x >> 1), y: y >> 1, key: maskAt(holed, x, y) });
  return slots;
}

/** Boards of slots for pointing at tiles yourself, when the converter can't
 *  read an image's arrangement on its own. Each slot's key is a dual tile's
 *  corner bits or a blob tile's neighbour mask, as in LAYOUTS.
 *  `minimum` lists two slots that are enough on their own: one tile with an
 *  outer corner and one with an inner corner show every kind of terrain piece
 *  at one corner or another, and mirroring makes the rest. */
export const PICK_BOARDS = {
  dual: {
    family: 'dual',
    name: 'Dual-grid tiles',
    cols: 4,
    rows: 4,
    slots: fromRows(DUAL_STANDARD),
    minimum: [TL | TR | BL, BR],
  },
  blob: {
    family: 'blob',
    name: 'Blob tiles',
    cols: 5,
    rows: 3,
    slots: islandSlots(),
    minimum: [E | SE | S, 255 & ~SE],
  },
};

/** Read pieces from tiles picked by hand. `picks` is [{ key, x, y }]: a board
 *  slot's key, and the grid position of the image tile that fills it. Pieces
 *  the picks don't show are made from the ones they do, as for any source.
 *  Returns the same shape as readSource, with read 'picked'. */
export function readPicked(img, { family, tileSize, picks }) {
  const t = tileSize;
  if (!t || t < 2 || t % 2) throw new Error(`The tile size has to be an even number of pixels (got ${t}), because every tile is cut into quarters.`);
  const cols = Math.floor(img.width / t), rows = Math.floor(img.height / t);
  const slots = picks.filter((p) => p.x < cols && p.y < rows);
  const { pieces, tiles } = extract(img, t, null, { layout: { family, slots } });
  completePieces(pieces);
  return { read: 'picked', family, tileSize: t, pieces, tiles, cols, rows, split: null };
}

/** Kinds of terrain piece that no source tile showed at any corner, so they
 *  had to be made up from the fill. (A flat fill is fine: it's said separately.) */
export function missingKinds(pieces) {
  const shown = (kind) => [0, 1, 2, 3].some((pos) => {
    const p = pieces.get(pos, kind);
    return p && (p.how === 'found' || p.how === 'mirrored' || p.how === 'copied');
  });
  return FILLED_KINDS.filter((kind) => kind !== 'fill' && !shown(kind));
}

// ---------------------------------------------------------------------------
// Filling gaps

/** Where to borrow a missing overhang piece from: layered combinations of others. */
const OVERHANG_STAND_INS = [
  ['b111', [['b101', 'b011'], ['b100', 'b010']]],
  ['b110', [['b100', 'b010']]],
];

function dominantColour(pieces, kinds) {
  const counts = new Map();
  for (const kind of kinds) {
    for (let pos = 0; pos < 4; pos++) {
      const piece = pieces.get(pos, kind);
      if (!piece || piece.how !== 'found') continue;
      const px = piece.pixels;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) continue;
        const key = ((px[i] << 24) | (px[i + 1] << 16) | (px[i + 2] << 8) | px[i + 3]) >>> 0;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  let best = null, bestCount = 0;
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
  if (best === null) return null;
  return [(best >>> 24) & 255, (best >>> 16) & 255, (best >>> 8) & 255, best & 255];
}

function isSolid(pixels) {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 128) return false;
  return true;
}

/** True if every overhang piece the source showed is solid all over: the art
 *  sits on a solid background rather than a see-through one. */
function solidBackground(pieces) {
  let any = false;
  for (const kind of OVERHANG_KINDS) {
    for (let pos = 0; pos < 4; pos++) {
      const piece = pieces.get(pos, kind);
      if (!piece || piece.how !== 'found') continue;
      if (!isSolid(piece.pixels)) return false;
      any = true;
    }
  }
  return any;
}

/** Fill in pieces the source didn't show, marking how each was made:
 *  mirrored or copied from another corner, a flat fill or background, a
 *  stand-in, or layered. */
export function completePieces(pieces) {
  const size = pieces.half;
  for (const kind of ALL_KINDS) {
    for (let pos = 0; pos < 4; pos++) {
      if (pieces.get(pos, kind)) continue;
      for (const m of [1, 2, 3]) {
        const src = pieces.get(pos ^ m, kind);
        if (!src || src.how !== 'found') continue;
        if (kind === 'fill' || kind === EMPTY_KIND) {
          pieces.set(pos, kind, { pixels: src.pixels.slice(), how: 'copied', from: { pos: pos ^ m } });
        } else {
          pieces.set(pos, kind, { pixels: flip(src.pixels, size, (m & 1) !== 0, (m & 2) !== 0), how: 'mirrored', from: { pos: pos ^ m } });
        }
        break;
      }
    }
  }
  if (![0, 1, 2, 3].some((pos) => pieces.get(pos, 'fill'))) {
    const colour = dominantColour(pieces, FILLED_KINDS);
    if (colour) {
      for (let pos = 0; pos < 4; pos++) pieces.set(pos, 'fill', { pixels: solid(size, colour), how: 'flat', colour });
    }
  }
  // See-through art needs no background piece: blank is right. On a solid
  // background, a flat patch of its commonest colour stands in for one.
  if (![0, 1, 2, 3].some((pos) => pieces.get(pos, EMPTY_KIND)) && solidBackground(pieces)) {
    const colour = dominantColour(pieces, OVERHANG_KINDS);
    for (let pos = 0; pos < 4; pos++) pieces.set(pos, EMPTY_KIND, { pixels: solid(size, colour), how: 'flat', colour });
  }
  for (const kind of ['outer', 'hedge', 'vedge', 'inner']) {
    for (let pos = 0; pos < 4; pos++) {
      const fill = pieces.get(pos, 'fill');
      if (!pieces.get(pos, kind) && fill) pieces.set(pos, kind, { pixels: fill.pixels.slice(), how: 'stand-in' });
    }
  }
  for (const [kind, options] of OVERHANG_STAND_INS) {
    for (let pos = 0; pos < 4; pos++) {
      if (pieces.get(pos, kind)) continue;
      for (const option of options) {
        const parts = option.map((k) => pieces.get(pos, k));
        if (parts.every(Boolean)) {
          const base = pieces.get(pos, EMPTY_KIND);
          const solidBase = base && isSolid(base.pixels) ? base.pixels : null;
          pieces.set(pos, kind, { pixels: layer(parts.map((p) => p.pixels), solidBase), how: 'layered', from: { kinds: option } });
          break;
        }
      }
    }
  }
  return pieces;
}

/** Counts of how each piece was made, for the status line. */
export function summarise(pieces) {
  const tally = (kinds) => {
    const out = { total: kinds.length * 4, found: 0, adapted: 0, madeUp: 0, missing: 0 };
    for (const kind of kinds) {
      for (let pos = 0; pos < 4; pos++) {
        const p = pieces.get(pos, kind);
        if (!p) out.missing++;
        else if (p.how === 'found') out.found++;
        else if (p.how === 'mirrored' || p.how === 'copied') out.adapted++;
        else out.madeUp++;
      }
    }
    return out;
  };
  const fill = pieces.get(0, 'fill');
  const background = pieces.get(0, EMPTY_KIND);
  return {
    terrain: tally(FILLED_KINDS),
    overhang: tally(OVERHANG_KINDS),
    flatFill: fill && fill.how === 'flat' ? fill.colour : null,
    flatBackground: background && background.how === 'flat' ? background.colour : null,
  };
}

// ---------------------------------------------------------------------------
// Writing layouts

export function drawTile(out, pieces, recipe, x0, y0, t) {
  const h = t >> 1;
  recipe.forEach((part, q) => {
    const piece = pieces.get(part.pos, part.kind);
    if (piece) paste(piece.pixels, h, h, out, x0 + (q & 1) * h, y0 + (q >> 1) * h);
  });
}

/** Build a whole sheet in `layout` from a set of pieces. */
export function composeSheet(pieces, layout, t) {
  const out = createImage(layout.cols * t, layout.rows * t);
  for (const slot of layout.slots) drawTile(out, pieces, recipeFor(layout, slot.key), slot.x * t, slot.y * t, t);
  return out;
}

/** Plain placeholder pieces: a flat block with an outline on every open side
 *  and a lighter band along top surfaces, for drawing your own art over. */
export function guidePieces(t) {
  const h = t >> 1;
  const pieces = new Pieces(h);
  const line = Math.max(1, Math.round(t / 16));
  const base = [120, 132, 150, 255], dark = [36, 40, 50, 255], light = [178, 190, 204, 255], clear = [0, 0, 0, 0];
  for (let pos = 0; pos < 4; pos++) {
    const right = (pos & 1) !== 0, bottom = (pos & 2) !== 0;
    const px = (x, y) => [right ? h - 1 - x : x, bottom ? h - 1 - y : y]; // measured from the cell's outer corner
    for (const kind of FILLED_KINDS) {
      const pixels = solid(h, base);
      const put = (x, y, rgba) => {
        const [ax, ay] = px(x, y);
        if (ax >= 0 && ay >= 0 && ax < h && ay < h) pixels.set(rgba, (ay * h + ax) * 4);
      };
      const verticalOpen = kind === 'outer' || kind === 'hedge';
      const horizontalOpen = kind === 'outer' || kind === 'vedge';
      for (let i = 0; i < line; i++) {
        for (let j = 0; j < h; j++) {
          if (verticalOpen && !bottom) put(j, line + i, light);
          if (verticalOpen) put(j, i, dark);
          if (horizontalOpen) put(i, j, dark);
        }
      }
      for (let i = 0; i < line; i++) {
        for (let j = 0; j < line; j++) {
          if (kind === 'inner') put(i, j, dark);
          if (kind === 'outer') put(i, j, clear);
        }
      }
      if (kind === 'outer') for (let i = 0; i < line; i++) for (let j = 0; j < line; j++) put(line + i, line + j, dark);
      pieces.set(pos, kind, { pixels, how: 'found' });
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Painting a test map

/** A world of cells to paint: { w, h, cells: Uint8Array (1 = filled) }. */
export function worldFromText(lines) {
  const h = lines.length, w = Math.max(...lines.map((l) => l.length));
  const cells = new Uint8Array(w * h);
  lines.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === '#') cells[y * w + x] = 1; }));
  return { w, h, cells };
}

export const DEMO_WORLD = [
  '....................',
  '.######......#......',
  '.######.....###.....',
  '.##..##......#......',
  '.##..##.............',
  '.######...##...##...',
  '.######...##..#..#..',
  '............##...#..',
  '..####......##.##...',
  '....................',
];

/** Paint `world` with a sheet the way a game would: look each cell (blob) or
 *  each corner (dual) up in the layout and copy that tile. Layouts that aren't
 *  autotile sheets are drawn straight from the pieces instead. Blob sheets
 *  have no tile for an empty cell, so those show the background piece, the
 *  way a game would show a plain background layer underneath. */
export function renderMap(world, t, layout, sheet, pieces) {
  const out = createImage(world.w * t, world.h * t);
  const on = (x, y) => x >= 0 && y >= 0 && x < world.w && y < world.h && world.cells[y * world.w + x] === 1;
  const h = t >> 1;
  const index = slotIndex(layout);
  if (layout.family === 'dual') {
    for (let vy = 0; vy <= world.h; vy++) {
      for (let vx = 0; vx <= world.w; vx++) {
        const key = (on(vx - 1, vy - 1) ? TL : 0) | (on(vx, vy - 1) ? TR : 0) | (on(vx - 1, vy) ? BL : 0) | (on(vx, vy) ? BR : 0);
        const slot = index.get(key);
        if (slot) blitRegion(sheet, slot.x * t, slot.y * t, t, t, out, vx * t - h, vy * t - h);
      }
    }
    return out;
  }
  const background = [0, 1, 2, 3].map((q) => ({ pos: q, kind: EMPTY_KIND }));
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      if (!on(x, y)) {
        drawTile(out, pieces, background, x * t, y * t, t);
        continue;
      }
      const mask = canonicalMask(maskAt(on, x, y));
      const key = layout.godot === 'sides' ? sidesMask(sidesOf(mask)) : mask;
      const slot = layout.paintable ? index.get(key) : null;
      if (slot) blitRegion(sheet, slot.x * t, slot.y * t, t, t, out, x * t, y * t);
      else drawTile(out, pieces, blobRecipe(mask), x * t, y * t, t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Godot TileSet resource

const TERRAIN_MODES = { 'corners-and-sides': 0, corners: 1, sides: 2 };
const PEERING = [
  [N, 'top_side'], [NE, 'top_right_corner'], [E, 'right_side'], [SE, 'bottom_right_corner'],
  [S, 'bottom_side'], [SW, 'bottom_left_corner'], [W, 'left_side'], [NW, 'top_left_corner'],
];
const CORNER_PEERING = ['top_left_corner', 'top_right_corner', 'bottom_left_corner', 'bottom_right_corner'];

/** A Godot 4 TileSet (.tres) for a sheet saved at `texturePath`, with one
 *  terrain whose peering bits are already painted on every tile.
 *  Returns null for layouts that aren't autotile sheets. */
export function godotTileSet(layout, { tileSize, texturePath, terrainName = 'Terrain', colour = [0.35, 0.7, 0.4] }) {
  if (!layout.godot) return null;
  const lines = [];
  for (const slot of layout.slots) {
    const at = `${slot.x}:${slot.y}/0`;
    lines.push(`${at} = 0`);
    if (layout.family === 'dual') {
      if (!slot.key) continue;
      lines.push(`${at}/terrain_set = 0`, `${at}/terrain = 0`);
      CORNER_PEERING.forEach((name, i) => {
        if ((slot.key >> i) & 1) lines.push(`${at}/terrains_peering_bit/${name} = 0`);
      });
    } else {
      lines.push(`${at}/terrain_set = 0`, `${at}/terrain = 0`);
      for (const [bit, name] of PEERING) {
        if (layout.godot === 'sides' && name.endsWith('_corner')) continue;
        if (slot.key & bit) lines.push(`${at}/terrains_peering_bit/${name} = 0`);
      }
    }
  }
  const quote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return [
    '[gd_resource type="TileSet" load_steps=3 format=3]',
    '',
    `[ext_resource type="Texture2D" path=${quote(texturePath)} id="1_sheet"]`,
    '',
    '[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_sheet"]',
    'texture = ExtResource("1_sheet")',
    `texture_region_size = Vector2i(${tileSize}, ${tileSize})`,
    ...lines,
    '',
    '[resource]',
    `tile_size = Vector2i(${tileSize}, ${tileSize})`,
    `terrain_set_0/mode = ${TERRAIN_MODES[layout.godot]}`,
    `terrain_set_0/terrain_0/name = ${quote(terrainName)}`,
    `terrain_set_0/terrain_0/color = Color(${colour.join(', ')}, 1)`,
    'sources/0 = SubResource("TileSetAtlasSource_sheet")',
    '',
  ].join('\n');
}
