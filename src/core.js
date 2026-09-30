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
export const ALL_KINDS = [...FILLED_KINDS, ...OVERHANG_KINDS];

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
};

/** The piece a quarter shows, from its own cell and three neighbours.
 *  Returns null for an empty quarter with nothing filled nearby. */
export function pieceKind(filled, vertical, horizontal, diagonal) {
  if (filled) {
    if (!vertical && !horizontal) return 'outer';
    if (!vertical) return 'hedge';
    if (!horizontal) return 'vedge';
    if (!diagonal) return 'inner';
    return 'fill';
  }
  if (!vertical && !horizontal && !diagonal) return null;
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

/** Blob neighbour bits (the same numbering as Emberkin's tools/Blob47.gd). */
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
  return [0, 1, 2, 3].map((q) => {
    const kind = pieceKind(c[q], c[q ^ 2], c[q ^ 1], c[q ^ 3]);
    return kind ? { pos: 3 - q, kind } : null;
  });
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
    id: 'blob-emberkin',
    family: 'blob',
    godot: 'corners-and-sides',
    paintable: true,
    name: 'Blob 47 · Emberkin 8-column',
    file: 'blob_8col',
    blurb: 'The same 47 tiles in Emberkin’s order (tools/Blob47.gd): sorted by neighbour mask, 8 to a row, slot (7,5) left empty.',
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
    name: '3×3 ring + fill · Emberkin source block',
    file: 'ring_3x3',
    blurb: 'A 3×3 block with a hole in the middle, and a fill tile below it: the source-block shape Emberkin’s Blob-47 generator reads.',
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

/** Later layers drawn over earlier ones wherever they have a visible pixel. */
function layer(list) {
  const out = list[0].slice();
  for (const top of list.slice(1)) {
    for (let i = 0; i < top.length; i += 4) {
      if (top[i + 3] > 0) out.set(top.subarray(i, i + 4), i);
    }
  }
  return out;
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

/** Side of the square sampled at each dual tile's corners. */
function cornerSample(t) {
  return Math.max(1, t >> 2);
}

/** A dual tile's corner bits, read from the pixels at its four corners.
 *  A corner of a dual tile is the middle of a terrain cell, as far from that
 *  cell's edges as you can get, so edge art rarely reaches it. */
export function dualCornersAt(img, x0, y0, t) {
  const s = cornerSample(t);
  const spots = [[0, 0], [t - s, 0], [0, t - s], [t - s, t - s]];
  let key = 0;
  spots.forEach(([dx, dy], i) => {
    if (coverage(img, x0 + dx, y0 + dy, s, s) >= 0.5) key |= 1 << i;
  });
  return key;
}

function cellFilled(img, x0, y0, t) {
  const m = t >> 2;
  return coverage(img, x0 + m, y0 + m, t - 2 * m, t - 2 * m) >= 0.5;
}

/** How far from clean on/off the sampled spots are: 0 = every spot clearly
 *  full or clearly empty. */
function ambiguity(img, t, mode) {
  const cols = Math.floor(img.width / t), rows = Math.floor(img.height / t);
  let sum = 0, count = 0;
  const add = (c) => { sum += Math.min(c, 1 - c); count++; };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = x * t, y0 = y * t;
      if (coverage(img, x0, y0, t, t) === 0) continue;
      if (mode === 'dual') {
        const s = cornerSample(t);
        for (const [dx, dy] of [[0, 0], [t - s, 0], [0, t - s], [t - s, t - s]]) add(coverage(img, x0 + dx, y0 + dy, s, s));
      } else {
        const m = t >> 2;
        add(coverage(img, x0 + m, y0 + m, t - 2 * m, t - 2 * m));
      }
    }
  }
  return count ? sum / count : null;
}

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
 *  pass for a coarser one; the rebuild and contradiction terms catch the second. */
function readingScore(img, t, mode) {
  const amb = ambiguity(img, t, mode);
  if (amb === null) return null;
  const { pieces, placements } = extract(img, t, mode, null);
  const h = t >> 1;
  const rebuilt = createImage(t, t);
  let quarters = 0, contradiction = 0, pixels = 0, wrong = 0;
  for (const { x0, y0, recipe } of placements) {
    recipe.forEach((part, q) => {
      const cov = coverage(img, x0 + (q & 1) * h, y0 + (q >> 1) * h, h, h);
      const filled = part !== null && FILLED_KINDS.includes(part.kind);
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

/** Guess the tile size and grid reading: of the readings that score within a
 *  whisker of the best, the one with the biggest tiles, since a finer grid can
 *  always explain an image by cutting real tiles into smaller ones. */
export function detect(img, { mode = null, tileSize = 0 } = {}) {
  const sizes = tileSize ? [tileSize] : candidateSizes(img.width, img.height);
  const modes = mode ? [mode] : ['dual', 'terrain'];
  const results = [];
  for (const t of sizes) {
    if (t < 2 || t % 2) continue;
    for (const m of modes) {
      const score = readingScore(img, t, m);
      if (score !== null) results.push({ mode: m, tileSize: t, score });
    }
  }
  if (!results.length) return null;
  const best = Math.min(...results.map((r) => r.score));
  const close = results.filter((r) => r.score <= best + 0.02);
  close.sort((a, b) => b.tileSize - a.tileSize || a.score - b.score);
  return { ...close[0], results };
}

/** Cut an image into pieces, reading its grid as `mode` ('dual', 'terrain', or
 *  a layout's slots). Returns the pieces, the tiles it found, and every tile's
 *  recipe with its position (placements), for checking the reading. */
function extract(img, t, mode, layout) {
  const pieces = new Pieces(t >> 1);
  const placements = [];
  const tiles = [];
  const take = (recipe, x0, y0, from) => {
    placements.push({ x0, y0, recipe });
    const h = t >> 1;
    recipe.forEach((part, q) => {
      if (part) pieces.offer(part.pos, part.kind, crop(img, x0 + (q & 1) * h, y0 + (q >> 1) * h, h, h), { ...from, q });
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
        const key = dualCornersAt(img, x * t, y * t, t);
        tiles.push({ x, y, key });
        take(dualRecipe(key), x * t, y * t, { x, y });
      }
    }
  } else {
    const grid = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) grid.push(cellFilled(img, x * t, y * t, t));
    const filled = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const on = filled(x, y);
        const mask = maskAt(filled, x, y);
        if (!on && !mask && coverage(img, x * t, y * t, t, t) === 0) continue;
        if (on) tiles.push({ x, y, key: mask });
        // A lone, completely solid tile is a fill swatch, not an island.
        const swatch = on && mask === 0 && coverage(img, x * t, y * t, t, t) === 1;
        const recipe = QUARTER_BITS.map(([v, hb, d], q) => {
          const kind = swatch ? 'fill' : pieceKind(on, mask & v, mask & hb, mask & d);
          return kind ? { pos: q, kind } : null;
        });
        take(recipe, x * t, y * t, { x, y });
      }
    }
  }
  return { pieces, tiles, placements };
}

/** Read a source image into pieces.
 *  `read` is 'auto', 'dual', 'terrain' or a layout id; `tileSize` 0 = work it out.
 *  Returns { read, tileSize, pieces, tiles, cols, rows } or throws a readable Error. */
export function readSource(img, { read = 'auto', tileSize = 0 } = {}) {
  let t = tileSize;
  let mode = read;
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
  }
  if (t < 2 || t % 2) throw new Error(`The tile size has to be an even number of pixels (got ${t}), because every tile is cut into quarters.`);
  const { pieces, tiles } = extract(img, t, mode, layout);
  completePieces(pieces);
  return { read: mode, tileSize: t, pieces, tiles, cols: Math.floor(img.width / t), rows: Math.floor(img.height / t) };
}

// ---------------------------------------------------------------------------
// Filling gaps

/** Where to borrow a missing overhang piece from: layered combinations of others. */
const OVERHANG_STAND_INS = [
  ['b111', [['b101', 'b011'], ['b100', 'b010']]],
  ['b110', [['b100', 'b010']]],
];

function dominantColour(pieces) {
  const counts = new Map();
  for (const kind of FILLED_KINDS) {
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

/** Fill in pieces the source didn't show, marking how each was made:
 *  mirrored or copied from another corner, a flat fill, a stand-in, or layered. */
export function completePieces(pieces) {
  const size = pieces.half;
  for (const kind of ALL_KINDS) {
    for (let pos = 0; pos < 4; pos++) {
      if (pieces.get(pos, kind)) continue;
      for (const m of [1, 2, 3]) {
        const src = pieces.get(pos ^ m, kind);
        if (!src || src.how !== 'found') continue;
        if (kind === 'fill') {
          pieces.set(pos, kind, { pixels: src.pixels.slice(), how: 'copied', from: { pos: pos ^ m } });
        } else {
          pieces.set(pos, kind, { pixels: flip(src.pixels, size, (m & 1) !== 0, (m & 2) !== 0), how: 'mirrored', from: { pos: pos ^ m } });
        }
        break;
      }
    }
  }
  if (![0, 1, 2, 3].some((pos) => pieces.get(pos, 'fill'))) {
    const colour = dominantColour(pieces);
    if (colour) {
      for (let pos = 0; pos < 4; pos++) pieces.set(pos, 'fill', { pixels: solid(size, colour), how: 'flat', colour });
    }
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
          pieces.set(pos, kind, { pixels: layer(parts.map((p) => p.pixels)), how: 'layered', from: { kinds: option } });
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
  return {
    terrain: tally(FILLED_KINDS),
    overhang: tally(OVERHANG_KINDS),
    flatFill: fill && fill.how === 'flat' ? fill.colour : null,
  };
}

// ---------------------------------------------------------------------------
// Writing layouts

export function drawTile(out, pieces, recipe, x0, y0, t) {
  const h = t >> 1;
  recipe.forEach((part, q) => {
    if (!part) return;
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
 *  autotile sheets are drawn straight from the pieces instead. */
export function renderMap(world, t, layout, sheet, pieces) {
  const out = createImage(world.w * t, world.h * t);
  const on = (x, y) => x >= 0 && y >= 0 && x < world.w && y < world.h && world.cells[y * world.w + x] === 1;
  const h = t >> 1;
  const index = slotIndex(layout);
  if (layout.family === 'dual') {
    for (let vy = 0; vy <= world.h; vy++) {
      for (let vx = 0; vx <= world.w; vx++) {
        const key = (on(vx - 1, vy - 1) ? TL : 0) | (on(vx, vy - 1) ? TR : 0) | (on(vx - 1, vy) ? BL : 0) | (on(vx, vy) ? BR : 0);
        const slot = key ? index.get(key) : null;
        if (slot) blitRegion(sheet, slot.x * t, slot.y * t, t, t, out, vx * t - h, vy * t - h);
      }
    }
    return out;
  }
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      if (!on(x, y)) continue;
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
