// The example's art: original placeholder terrain in the dual-grid example
// layout, drawn from simple geometry so it is free to share. A 3x3 block of
// tiles around a hole gives the inner corners and edges, a 2x2 block around a
// one-cell island gives the outer corners, and a solid tile gives the fill.
//
// With { water: true } the sand sits on water instead of on nothing: every
// empty part of every tile is filled, and a wide shoreline runs from the sand
// out into the water. tools/make-example.mjs writes the plain version; the
// tests use both.
import * as core from '../src/core.js';

const OUTLINE = [58, 44, 38, 255];
const RIM_COLOUR = [214, 170, 110, 255];
const FILL = [186, 138, 84, 255];
const SPECK = [160, 116, 68, 255];
const FOAM = [226, 232, 220, 255];
const SHALLOWS = [70, 150, 190, 255];
const WATER = [40, 110, 190, 255];

/** Signed distance from (x, y) to a quadrant {sx * x >= 0, sy * y >= 0} whose corner is rounded by r. */
function roundedQuadrant(x, y, sx, sy, r) {
  const dx = r - sx * x, dy = r - sy * y;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

const SIGNS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Signed distance to the terrain edge near a grid corner at the origin,
 *  given which of the four cells around it are filled (tl, tr, bl, br). */
function terrainDistance(x, y, cells, T) {
  const filled = cells.filter(Boolean).length;
  if (filled === 0) return Infinity;
  if (filled === 4) return -Infinity;
  if (filled === 3) {
    const [sx, sy] = SIGNS[cells.indexOf(false)];
    return -roundedQuadrant(x, y, sx, sy, T * 0.25);
  }
  if (cells[0] && cells[1]) return y;
  if (cells[2] && cells[3]) return -y;
  if (cells[0] && cells[2]) return x;
  if (cells[1] && cells[3]) return -x;
  // One cell, or two touching only at the corner: separate rounded blobs.
  return Math.min(...[0, 1, 2, 3].filter((i) => cells[i]).map((i) => roundedQuadrant(x, y, ...SIGNS[i], T * 0.3)));
}

function colourAt(sd, i, j, T, water) {
  if (sd > 1) {
    // Past a one-pixel outline just outside the cell: the art overhangs.
    if (!water) return null;
    if (sd <= T * 0.36) return FOAM;
    if (sd <= T * 0.4) return SHALLOWS;
    return WATER;
  }
  if (sd > 0) return OUTLINE;
  if (sd > -T / 8) return RIM_COLOUR;
  const speck = (i === 2 && j === 5) || (i === 5 && j === 2) || (i === 6 && j === 6);
  return speck && sd < -T / 8 - 1 ? SPECK : FILL;
}

/** Every piece, drawn from the shape of the four cells around its corner. */
export function examplePieces(T, { water = false } = {}) {
  const H = T / 2;
  const pieces = new core.Pieces(H);
  for (let pos = 0; pos < 4; pos++) {
    const right = (pos & 1) !== 0, bottom = (pos & 2) !== 0;
    for (const kind of core.ALL_KINDS) {
      // Read the piece's own cell and neighbours back out of its kind.
      const filled = core.FILLED_KINDS.includes(kind);
      const bits = filled
        ? { fill: [1, 1, 1], outer: [0, 0, 0], hedge: [0, 1, 1], vedge: [1, 0, 1], inner: [1, 1, 0] }[kind]
        : kind === core.EMPTY_KIND ? [0, 0, 0] : [...kind.slice(1)].map(Number);
      const [v, h, d] = bits;
      // Seen from the corner, the piece's cell is bottom-right; its neighbours
      // across the corner are bottom-left (h), top-right (v) and top-left (d).
      const cells = [!!d, !!v, !!h, filled];
      const pixels = new Uint8ClampedArray(H * H * 4);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < H; i++) {
          const colour = colourAt(terrainDistance(i + 0.5, j + 0.5, cells, T), i, j, T, water);
          if (!colour) continue;
          const px = right ? H - 1 - i : i, py = bottom ? H - 1 - j : j;
          pixels.set(colour, (py * H + px) * 4);
        }
      }
      pieces.set(pos, kind, { pixels, how: 'found' });
    }
  }
  return pieces;
}

const { TL, TR, BL, BR } = core;
/** Corner bits for each tile of the example; null = no tile there. */
export const EXAMPLE_TILES = [
  [TL | TR | BL, TL | TR, TL | TR | BR],
  [TL | BL, 0, TR | BR],
  [TL | BL | BR, BL | BR, TR | BL | BR],
  [BR, BL, null],
  [TR, TL, TL | TR | BL | BR],
];

export function exampleImage(T, options = {}) {
  const pieces = examplePieces(T, options);
  const image = core.createImage(3 * T, EXAMPLE_TILES.length * T);
  EXAMPLE_TILES.forEach((row, y) => row.forEach((key, x) => {
    if (key !== null) core.drawTile(image, pieces, core.dualRecipe(key), x * T, y * T, T);
  }));
  return image;
}
