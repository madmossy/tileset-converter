import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../src/core.js';
import { decodePng, encodePng } from '../tools/png.mjs';
import { exampleImage, examplePieces, EXAMPLE_TILES } from '../tools/example-art.mjs';

const example = () => decodePng(readFileSync(new URL('../examples/dual-example.png', import.meta.url)));

/** The example's sand on water instead of on nothing: every empty part of every
 *  tile is filled, and a wide shoreline reaches most of the way to the middle
 *  of each water cell. The unused slot stays see-through, and so, unless
 *  `fillSwatch`, does the fill tile. */
function waterExample(t, { fillSwatch = false } = {}) {
  const img = exampleImage(t, { water: true });
  if (!fillSwatch) core.blitRegion(core.createImage(t, t), 0, 0, t, t, img, 2 * t, 4 * t);
  return img;
}

const examplePiecesOnWater = (t) => examplePieces(t, { water: true });

const nearer = (rgb, a, b) => {
  const d = (c) => c.reduce((sum, v, i) => sum + (v - rgb[i]) ** 2, 0);
  return d(a) < d(b);
};
const SAND = [186, 138, 84], WATER = [40, 110, 190];

/** Corner bits the example's tiles should read as, row by row. */
const exampleKeys = (fillSwatch) => EXAMPLE_TILES.flatMap((row, y) => row.map((key, x) => ({ x, y, key })))
  .filter(({ x, y, key }) => key !== null && (fillSwatch || !(x === 2 && y === 4)));

/** Pieces where every position x kind is a distinct, fully opaque pattern. */
function distinctPieces(half) {
  const pieces = new core.Pieces(half);
  core.ALL_KINDS.forEach((kind, k) => {
    for (let pos = 0; pos < 4; pos++) {
      const px = new Uint8ClampedArray(half * half * 4);
      for (let i = 0; i < half * half; i++) px.set([(k * 20 + i) & 255, pos * 60, (i * 7) & 255, 255], i * 4);
      pieces.set(pos, kind, { pixels: px, how: 'found' });
    }
  });
  return pieces;
}

const bit = (key, i) => (key >> i) & 1;

test('the standard dual sheet holds each corner set once, and touching tiles share corners', () => {
  const layout = core.layoutById('dual-standard');
  assert.deepEqual(layout.slots.map((s) => s.key).sort((a, b) => a - b), [...Array(16).keys()]);
  const at = new Map(layout.slots.map((s) => [`${s.x},${s.y}`, s.key]));
  for (const s of layout.slots) {
    const right = at.get(`${s.x + 1},${s.y}`);
    if (right !== undefined) {
      assert.equal(bit(s.key, 1), bit(right, 0), `(${s.x},${s.y}) top-right vs its right neighbour`);
      assert.equal(bit(s.key, 3), bit(right, 2), `(${s.x},${s.y}) bottom-right vs its right neighbour`);
    }
    const below = at.get(`${s.x},${s.y + 1}`);
    if (below !== undefined) {
      assert.equal(bit(s.key, 2), bit(below, 0), `(${s.x},${s.y}) bottom-left vs the tile below`);
      assert.equal(bit(s.key, 3), bit(below, 1), `(${s.x},${s.y}) bottom-right vs the tile below`);
    }
  }
});

test('both blob-47 sheets hold the 47 neighbourhoods once each', () => {
  const all = core.blobMasks();
  assert.equal(all.length, 47);
  for (const id of ['blob-godot', 'blob-sorted']) {
    const keys = core.layoutById(id).slots.map((s) => s.key);
    assert.equal(keys.length, 47, id);
    assert.deepEqual([...keys].sort((a, b) => a - b), all, id);
  }
});

test('the sorted sheet puts slot i at column i % 8, row i / 8, masks ascending', () => {
  const layout = core.layoutById('blob-sorted');
  layout.slots.forEach((s, i) => {
    assert.deepEqual([s.x, s.y], [i % 8, i >> 3]);
    if (i) assert.ok(s.key > layout.slots[i - 1].key, `slot ${i} is out of order`);
  });
  const slotOf = (mask) => layout.slots.find((s) => s.key === mask);
  assert.deepEqual([slotOf(0).x, slotOf(0).y], [0, 0]);
  assert.deepEqual([slotOf(255).x, slotOf(255).y], [6, 5]);
  assert.ok(!layout.slots.some((s) => s.x === 7 && s.y === 5), 'the last slot is left empty');
});

test('the Match Sides sheet has 16 tiles with no inner corners', () => {
  const layout = core.layoutById('sides-16');
  assert.equal(new Set(layout.slots.map((s) => s.key)).size, 16);
  for (const s of layout.slots) {
    for (const part of core.blobRecipe(s.key)) assert.notEqual(part.kind, 'inner');
  }
});

test('the minimal and ring sheets contain every terrain piece', () => {
  for (const id of ['minimal', 'ring']) {
    const layout = core.layoutById(id);
    const seen = new Set();
    for (const s of layout.slots) for (const part of core.recipeFor(layout, s.key)) seen.add(part.pos + part.kind);
    for (const kind of core.FILLED_KINDS) for (let pos = 0; pos < 4; pos++) assert.ok(seen.has(pos + kind), `${id} lacks ${kind} at ${pos}`);
  }
});

test('every layout reads back to the pieces it was built from', () => {
  const t = 16;
  const pieces = distinctPieces(t / 2);
  for (const layout of core.LAYOUTS) {
    const sheet = core.composeSheet(pieces, layout, t);
    const back = core.readSource(sheet, { read: layout.id });
    assert.equal(back.tileSize, t, layout.id);
    const again = core.composeSheet(back.pieces, layout, t);
    assert.deepEqual(again.data, sheet.data, layout.id);
  }
});

test('the dual sheet carries every piece, so it converts into every other layout', () => {
  const t = 16;
  const pieces = distinctPieces(t / 2);
  const dual = core.composeSheet(pieces, core.layoutById('dual-standard'), t);
  const back = core.readSource(dual, { read: 'dual-standard' });
  for (const kind of core.ALL_KINDS) {
    for (let pos = 0; pos < 4; pos++) assert.equal(back.pieces.get(pos, kind).how, 'found', `${kind} at ${pos}`);
  }
  for (const layout of core.LAYOUTS) {
    assert.deepEqual(core.composeSheet(back.pieces, layout, t).data, core.composeSheet(pieces, layout, t).data, layout.id);
  }
});

test('a dual sheet in any arrangement is read from its pixels alone', () => {
  const guide = core.guidePieces(16);
  for (const id of ['dual-standard', 'dual-binary']) {
    const sheet = core.composeSheet(guide, core.layoutById(id), 16);
    const found = core.detect(sheet);
    assert.equal(found.mode, 'dual', id);
    assert.equal(found.tileSize, 16, id);
    const back = core.readSource(sheet);
    for (const layout of core.LAYOUTS) {
      assert.deepEqual(core.composeSheet(back.pieces, layout, 16).data, core.composeSheet(guide, layout, 16).data, `${id} -> ${layout.id}`);
    }
  }
});

test('a terrain drawing is read cell by cell, and a lone solid tile is taken as the fill', () => {
  const guide = core.guidePieces(32);
  const ring = core.composeSheet(guide, core.layoutById('ring'), 32);
  const back = core.readSource(ring);
  assert.equal(back.read, 'terrain');
  assert.equal(back.tileSize, 32);
  assert.equal(back.pieces.get(0, 'fill').how, 'found');
  const blob = core.layoutById('blob-godot');
  assert.deepEqual(core.composeSheet(back.pieces, blob, 32).data, core.composeSheet(guide, blob, 32).data);
});

test('solid-looking sheets are not mistaken for a coarser or finer grid', () => {
  // A ring of mostly-solid tiles also reads cleanly as all-filled dual tiles,
  // and a tidy 4x4 dual sheet as a 2x2 of bigger tiles; rebuilding catches both.
  const drawn = core.readSource(example()).pieces;
  const ring = core.detect(core.composeSheet(drawn, core.layoutById('ring'), 16));
  assert.deepEqual([ring.mode, ring.tileSize], ['terrain', 16]);
  const guide = core.guidePieces(16);
  const numbered = core.detect(core.composeSheet(guide, core.layoutById('dual-binary'), 16));
  assert.deepEqual([numbered.mode, numbered.tileSize], ['dual', 16]);
});

test('the example reads as 16px dual-grid tiles with every terrain piece present', () => {
  const source = core.readSource(example());
  assert.equal(source.read, 'dual');
  assert.equal(source.tileSize, 16);
  // The hole: inner corners, then edges, around an empty middle.
  const keys = new Map(source.tiles.map((t) => [`${t.x},${t.y}`, t.key]));
  assert.equal(keys.get('0,0'), core.TL | core.TR | core.BL);
  assert.equal(keys.get('1,0'), core.TL | core.TR);
  assert.ok(!keys.has('1,1'), 'the middle of the hole is empty');
  // The island: four outer corners.
  assert.equal(keys.get('0,3'), core.BR);
  assert.equal(keys.get('1,4'), core.TL);
  // The fill swatch: a solid tile reads as all four corners filled.
  assert.equal(keys.get('2,4'), core.TL | core.TR | core.BL | core.BR);
  const s = core.summarise(source.pieces);
  assert.equal(s.terrain.found, 20);
  assert.equal(s.flatFill, null);
  assert.equal(s.overhang.missing, 0);
});

test('without a fill tile, the fill is the art’s commonest colour', () => {
  const img = example();
  const blank = core.createImage(16, 16);
  core.blitRegion(blank, 0, 0, 16, 16, img, 32, 64); // clear the fill swatch
  const source = core.readSource(img);
  const s = core.summarise(source.pieces);
  assert.equal(s.terrain.found, 16, 'everything but the fill');
  assert.deepEqual(s.flatFill, [186, 138, 84, 255]);
});

test('converting the example to dual grid keeps the tiles it came from', () => {
  const img = example();
  const source = core.readSource(img);
  // Tiles whose pieces were all first found in that very tile must come back pixel for pixel.
  for (const tile of source.tiles) {
    const recipe = core.dualRecipe(tile.key);
    const own = recipe.every((part, q) => {
      if (!part) return true;
      const p = source.pieces.get(part.pos, part.kind);
      return p.how === 'found' && p.from.x === tile.x && p.from.y === tile.y && p.from.q === q;
    });
    if (!own) continue;
    const out = core.createImage(16, 16);
    core.drawTile(out, source.pieces, recipe, 0, 0, 16);
    const original = core.createImage(16, 16);
    core.blitRegion(img, tile.x * 16, tile.y * 16, 16, 16, original, 0, 0);
    assert.deepEqual(out.data, original.data, `tile ${tile.x},${tile.y}`);
  }
});

test('tiles on a solid background are read by colour, the same as see-through ones', () => {
  for (const t of [16, 32]) {
    for (const fillSwatch of [true, false]) {
      const label = `${t}px, ${fillSwatch ? 'with' : 'without'} a fill tile`;
      const source = core.readSource(waterExample(t, { fillSwatch }));
      assert.deepEqual([source.read, source.tileSize], ['dual', t], label);
      assert.deepEqual(source.tiles.map(({ x, y, key }) => ({ x, y, key })), exampleKeys(fillSwatch), label);
      assert.ok(nearer(source.split.terrain, SAND, WATER), `${label}: the sand is the terrain`);
      assert.ok(nearer(source.split.background, WATER, SAND), `${label}: the water is the background`);
      const s = core.summarise(source.pieces);
      assert.equal(s.terrain.found, fillSwatch ? 20 : 16, label);
      assert.equal(s.overhang.found, 24, label);
      assert.equal(s.overhang.missing, 0, label);
      assert.equal(s.flatBackground, null, `${label}: the empty middle tile gives the background`);
      for (let pos = 0; pos < 4; pos++) assert.equal(source.pieces.get(pos, core.EMPTY_KIND).how, 'found', label);
    }
  }
});

test('swapping reads the background as the terrain instead', () => {
  const source = core.readSource(waterExample(16), { swap: true });
  assert.ok(nearer(source.split.terrain, WATER, SAND));
  assert.deepEqual(source.tiles.map(({ x, y, key }) => ({ x, y, key })), exampleKeys(false).map((tile) => ({ ...tile, key: 15 - tile.key })));
  const s = core.summarise(source.pieces);
  assert.equal(s.terrain.found, 20, 'the all-water tile is now the fill');
  assert.deepEqual(s.flatBackground, [...SAND, 255], 'and the background is flat sand');
});

test('converting tiles on a solid background keeps the tiles they came from', () => {
  // The art is drawn from one set of pieces, so every tile rebuilds exactly.
  const t = 16;
  const img = waterExample(t);
  const source = core.readSource(img);
  for (const tile of source.tiles) {
    const out = core.createImage(t, t);
    core.drawTile(out, source.pieces, core.dualRecipe(tile.key), 0, 0, t);
    const original = core.createImage(t, t);
    core.blitRegion(img, tile.x * t, tile.y * t, t, t, original, 0, 0);
    assert.deepEqual(out.data, original.data, `tile ${tile.x},${tile.y}`);
  }
  // Every dual tile comes out solid, the empty one plain water.
  const layout = core.layoutById('dual-standard');
  const sheet = core.composeSheet(source.pieces, layout, t);
  assert.ok(!core.hasTransparency(sheet));
  const empty = layout.slots.find((slot) => slot.key === 0);
  const px = (x, y) => [...sheet.data.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 3)];
  for (const [dx, dy] of [[0, 0], [t - 1, 0], [t >> 1, t >> 1], [0, t - 1]]) assert.deepEqual(px(empty.x * t + dx, empty.y * t + dy), WATER);
});

test('blob tiles draw overhanging art inside the cell, pulled in as far as it overhangs', () => {
  const t = 16;
  const see = core.readSource(example()).pieces;
  assert.deepEqual(core.overhangDepths(see), { top: 1, bottom: 1, left: 1, right: 1 }, 'the example’s one-pixel outline');
  const water = core.readSource(waterExample(t)).pieces;
  assert.deepEqual(core.overhangDepths(water), { top: 6, bottom: 6, left: 6, right: 6 }, 'the shoreline');
  const layout = core.layoutById('blob-sorted');
  const sheet = core.composeSheet(water, layout, t);
  const px = (x, y) => [...sheet.data.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 3)];
  const SAND_COLOURS = ['186,138,84', '214,170,110', '160,116,68'];
  const isSand = (rgb) => SAND_COLOURS.includes(rgb.join());
  for (const slot of layout.slots) {
    const x0 = slot.x * t, y0 = slot.y * t;
    assert.ok(isSand(px(x0 + t / 2, y0 + t / 2)), `mask ${slot.key}: sand in the middle`);
    // Each open side shows shoreline or water along its edge, not sand.
    const sides = { top: [core.N, (i) => [i, 0]], bottom: [core.S, (i) => [i, t - 1]], left: [core.W, (i) => [0, i]], right: [core.E, (i) => [t - 1, i]] };
    for (const [side, [bit, at]] of Object.entries(sides)) {
      if (slot.key & bit) continue;
      for (let i = 0; i < t; i++) {
        const [x, y] = at(i);
        assert.ok(!isSand(px(x0 + x, y0 + y)), `mask ${slot.key}: sand at the ${side} edge`);
      }
    }
  }
  // Art with nothing spilling over is left alone.
  const guide = core.guidePieces(t);
  assert.equal(core.blobPieces(guide), guide);
});

test('the ring’s hole shows the background, and reading a ring sheet picks it up', () => {
  const t = 16;
  const layout = core.layoutById('ring');
  const hole = layout.slots.find((slot) => slot.key === core.BACKGROUND);
  assert.deepEqual([hole.x, hole.y], [1, 1]);
  const water = core.readSource(waterExample(t)).pieces;
  const sheet = core.composeSheet(water, layout, t);
  for (let y = 0; y < t; y++) {
    for (let x = 0; x < t; x++) {
      const i = ((t + y) * sheet.width + t + x) * 4;
      assert.deepEqual([...sheet.data.subarray(i, i + 4)], [...WATER, 255], `hole pixel ${x},${y}`);
    }
  }
  const back = core.readSource(sheet, { read: 'ring' });
  assert.equal(back.pieces.get(0, core.EMPTY_KIND).how, 'found');
  // See-through art leaves the hole blank, as before.
  const see = core.composeSheet(core.readSource(example()).pieces, layout, t);
  assert.equal(see.data[((t + 8) * see.width + t + 8) * 4 + 3], 0);
});

test('the foreground and background fills can be picked by hand', () => {
  const t = 16;
  const img = waterExample(t); // no plain sand tile, so the foreground fill is made up
  const quarter = (x, y, q) => {
    const out = core.createImage(t / 2, t / 2);
    core.blitRegion(img, x * t + (q & 1) * (t / 2), y * t + (q >> 1) * (t / 2), t / 2, t / 2, out, 0, 0);
    return out.data;
  };
  assert.deepEqual(core.summarise(core.readSource(img).pieces).flatFill, [...SAND, 255]);
  // Pick the all-water middle tile as the foreground fill, and the see-through
  // corner as the background fill: odd choices, but they're taken as picked.
  const plain = { fill: { x: 1, y: 1 }, background: { x: 2, y: 4 } };
  for (const source of [core.readSource(img, { plain }), core.readPicked(img, { family: 'dual', tileSize: t, picks: [{ key: 7, x: 0, y: 0 }], plain })]) {
    for (let q = 0; q < 4; q++) {
      const fill = source.pieces.get(q, 'fill');
      assert.equal(fill.how, 'found');
      assert.deepEqual(fill.from, { x: 1, y: 1, q, picked: true });
      assert.deepEqual(fill.pixels, quarter(1, 1, q));
      assert.ok(source.pieces.get(q, core.EMPTY_KIND).pixels.every((v, i) => i % 4 !== 3 || v === 0), 'a see-through background');
    }
    const s = core.summarise(source.pieces);
    assert.equal(s.flatFill, null);
    assert.equal(s.flatBackground, null);
  }
  // Picks made on another grid, or off this one, are ignored.
  for (const other of [{ fill: { x: 1, y: 1 }, tileSize: 32 }, { fill: { x: 9, y: 9 } }]) {
    assert.deepEqual(core.summarise(core.readSource(img, { plain: other }).pieces).flatFill, [...SAND, 255]);
  }
});

/** An animation of the water example: `count` frames `spacing` apart,
 *  across (or down), with a sparkle moving through the water. */
function animatedWater(t, count, spacing, axis = 'x') {
  const base = exampleImage(t, { water: true });
  const across = axis === 'x';
  const out = core.createImage(across ? count * base.width + (count - 1) * spacing : base.width, across ? base.height : count * base.height + (count - 1) * spacing);
  const frames = [];
  for (let k = 0; k < count; k++) {
    const f = { width: base.width, height: base.height, data: base.data.slice() };
    for (let i = 0; i < f.data.length; i += 4) {
      const p = i / 4, x = p % f.width, y = Math.floor(p / f.width);
      if (f.data.subarray(i, i + 3).join() === WATER.join() && (x + 2 * y + 3 * k) % 11 === 0) f.data.set([120, 180, 230, 255], i);
    }
    core.blitRegion(f, 0, 0, f.width, f.height, out, across ? k * (base.width + spacing) : 0, across ? 0 : k * (base.height + spacing));
    frames.push(f);
  }
  return { img: out, frames, base };
}

test('animation frames are found side by side or stacked, with or without gaps', () => {
  const t = 16;
  for (const [count, spacing, axis] of [[8, 0, 'x'], [4, 2, 'x'], [3, 0, 'y'], [2, 5, 'y']]) {
    const { img, frames, base } = animatedWater(t, count, spacing, axis);
    const found = core.detectFrames(img);
    const expect = axis === 'x' ? { cols: count, rows: 1 } : { cols: 1, rows: count };
    assert.deepEqual(found, { ...expect, spacing, width: base.width, height: base.height }, `${count} ${axis} ${spacing}px`);
    core.splitFrames(img, found).forEach((frame, k) => assert.deepEqual(frame.data, frames[k].data, `frame ${k}`));
  }
  // Still sheets are one frame.
  for (const pieces of [examplePieces(16), examplePiecesOnWater(16), examplePieces(32)]) {
    const tile = pieces.half * 2;
    for (const layout of core.LAYOUTS) {
      const f = core.detectFrames(core.composeSheet(pieces, layout, tile));
      assert.deepEqual([f.cols, f.rows], [1, 1], layout.id);
    }
  }
  for (const img of [example(), waterExample(t)]) assert.deepEqual(core.detectFrames(img), core.singleFrame(img));
  // Frames set by hand must divide the image evenly.
  const { img } = animatedWater(t, 4, 2, 'x');
  assert.deepEqual(core.frameLayout(img, { cols: 4, rows: 1, spacing: 2 }), { cols: 4, rows: 1, spacing: 2, width: 48, height: 80 });
  assert.equal(core.frameLayout(img, { cols: 5, rows: 1, spacing: 0 }), null);
});

test('every frame is read like the first, and the sheets and TileSets animate', () => {
  const t = 16, count = 4;
  const { img, frames } = animatedWater(t, count, 2, 'x');
  const split = core.splitFrames(img, core.detectFrames(img));
  const source = core.readSource(split[0]);
  const framePieces = split.map((frame, k) => (k ? core.readFrame(frame, source) : source.pieces));
  const layout = core.layoutById('dual-standard');
  const strip = core.composeFrames(framePieces, layout, t);
  assert.deepEqual([strip.width, strip.height], [count * layout.cols * t, layout.rows * t]);
  // Each frame's sheet is what reading that frame on its own would give.
  framePieces.forEach((pieces, k) => {
    const alone = core.readSource(frames[k]).pieces;
    const sheet = core.composeSheet(pieces, layout, t);
    assert.deepEqual(sheet.data, core.composeSheet(alone, layout, t).data, `frame ${k}`);
    const cut = core.createImage(sheet.width, sheet.height);
    core.blitRegion(strip, k * sheet.width, 0, sheet.width, sheet.height, cut, 0, 0);
    assert.deepEqual(cut.data, sheet.data, `frame ${k} in the strip`);
  });
  assert.notDeepEqual(core.composeSheet(framePieces[0], layout, t).data, core.composeSheet(framePieces[1], layout, t).data, 'the frames differ');
  const tres = core.godotTileSet(layout, { tileSize: t, texturePath: 'res://a.png', animation: { frames: count, seconds: 0.25 } });
  // Godot counts the gap between a tile's frames in tiles: the rest of the sheet.
  assert.equal(tres.match(/\/animation_separation = Vector2i\(3, 0\)$/gm).length, 16);
  assert.equal(tres.match(/^0:0\/animation_frame_\d\/duration = 0.25$/gm).length, count);
  assert.ok(tres.indexOf('0:0/animation_frame_3/duration') < tres.indexOf('0:0/0 = 0'), 'the animation comes before the tile');
  assert.doesNotMatch(core.godotTileSet(layout, { tileSize: t, texturePath: 'res://a.png' }), /animation/);
});

test('painting a map on a solid background shows the background away from the terrain', () => {
  const t = 16;
  const { pieces } = core.readSource(waterExample(t));
  const world = core.worldFromText(['....', '.##.', '....']);
  for (const id of ['dual-standard', 'blob-godot']) {
    const layout = core.layoutById(id);
    const map = core.renderMap(world, t, layout, core.composeSheet(pieces, layout, t), pieces);
    assert.ok(!core.hasTransparency(map), id);
    const i = (2 * map.width + 2) * 4;
    assert.deepEqual([...map.data.subarray(i, i + 3)], WATER, `${id}: a far corner is water`);
  }
});

test('a solid image keeps its border colour when that colour is the terrain', () => {
  const t = 16;
  const img = exampleImage(t, { water: true });
  core.drawTile(img, core.readSource(img).pieces, core.dualRecipe(0), 2 * t, 3 * t, t); // fill the unused slot too
  assert.ok(!core.hasTransparency(img));
  const border = core.borderColour(img);
  assert.deepEqual(border, SAND, 'most of the border is sand');
  assert.equal(core.isBackdrop(img, border), false);
  assert.equal(core.isBackdrop(img, WATER), true);
  assert.deepEqual(core.readSource(img).tiles.map((tile) => tile.key).slice(0, 9), exampleKeys(true).map((tile) => tile.key).slice(0, 9));
});

test('each pick board holds distinct slots, and its two minimum slots show every kind of terrain piece', () => {
  for (const [family, board] of Object.entries(core.PICK_BOARDS)) {
    assert.equal(board.family, family);
    const keys = board.slots.map((slot) => slot.key);
    assert.equal(new Set(keys).size, keys.length, family);
    if (family === 'blob') for (const key of keys) assert.equal(core.canonicalMask(key), key, `${family} ${key}`);
    assert.equal(new Set(board.slots.map((s) => `${s.x},${s.y}`)).size, keys.length, `${family}: one slot per place`);
    for (const key of board.minimum) assert.ok(keys.includes(key), `${family} ${key}`);
    const kinds = new Set(board.minimum.flatMap((key) => core.recipeFor(board, key).map((part) => part.kind)));
    for (const kind of ['outer', 'hedge', 'vedge', 'inner']) assert.ok(kinds.has(kind), `${family} minimum lacks ${kind}`);
  }
  assert.equal(core.PICK_BOARDS.dual.slots.length, 16);
  assert.equal(core.PICK_BOARDS.blob.slots.length, 13);
});

function terrainOnly(pieces) {
  const out = new core.Pieces(pieces.half);
  for (const kind of core.FILLED_KINDS) for (let pos = 0; pos < 4; pos++) out.set(pos, kind, pieces.get(pos, kind));
  return out;
}

/** A sheet with each of a board's tiles in a scrambled spot, and the picks
 *  that point at them. */
function scrambled(pieces, board, t) {
  const cols = 5;
  const img = core.createImage(cols * t, Math.ceil(board.slots.length / cols) * t);
  const picks = [...board.slots].reverse().map((slot, n) => {
    const x = (n * 3) % cols, y = Math.floor(n / cols);
    core.drawTile(img, pieces, core.recipeFor(board, slot.key), x * t, y * t, t);
    return { key: slot.key, x, y };
  });
  return { img, picks };
}

test('tiles picked by hand in any arrangement read back to the pieces they came from', () => {
  const t = 16;
  const pieces = distinctPieces(t / 2);
  for (const [family, board] of Object.entries(core.PICK_BOARDS)) {
    const { img, picks } = scrambled(pieces, board, t);
    const source = core.readPicked(img, { family, tileSize: t, picks });
    assert.equal(source.read, 'picked');
    assert.equal(source.tiles.length, board.slots.length);
    assert.deepEqual(core.missingKinds(source.pieces), []);
    // Dual tiles carry every piece; blob tiles only the terrain's own.
    const expected = family === 'dual' ? pieces : terrainOnly(pieces);
    const layouts = core.LAYOUTS.filter((l) => family === 'dual' || l.family === 'blob');
    for (const layout of layouts) {
      assert.deepEqual(core.composeSheet(source.pieces, layout, t).data, core.composeSheet(expected, layout, t).data, `${family} -> ${layout.id}`);
    }
  }
});

test('the two minimum picks are enough to make every piece of terrain', () => {
  const t = 16;
  const pieces = examplePiecesOnWater(t);
  for (const [family, board] of Object.entries(core.PICK_BOARDS)) {
    const { img, picks } = scrambled(pieces, board, t);
    const minimum = picks.filter((pick) => board.minimum.includes(pick.key));
    const source = core.readPicked(img, { family, tileSize: t, picks: minimum });
    assert.deepEqual(core.missingKinds(source.pieces), [], family);
    const s = core.summarise(source.pieces);
    assert.equal(s.terrain.missing, 0, family);
    assert.equal(s.terrain.found + s.terrain.adapted + (s.flatFill ? 4 : 0), 20, `${family}: nothing stands in for a missing kind`);
    // One pick short, and the kinds only it showed are missing.
    const one = core.readPicked(img, { family, tileSize: t, picks: minimum.slice(0, 1) });
    assert.ok(core.missingKinds(one.pieces).length > 0, family);
  }
});

test('picks off the grid are ignored, and the tile size must split into quarters', () => {
  const img = core.createImage(32, 32);
  const source = core.readPicked(img, { family: 'dual', tileSize: 16, picks: [{ key: 15, x: 5, y: 0 }] });
  assert.equal(source.tiles.length, 0);
  assert.throws(() => core.readPicked(img, { family: 'dual', tileSize: 15, picks: [] }), /even number/);
});

test('painting a map gives the same picture whichever sheet of a family is used', () => {
  const t = 16;
  const pieces = distinctPieces(t / 2);
  const world = core.worldFromText(core.DEMO_WORLD);
  const paint = (id) => {
    const layout = core.layoutById(id);
    return core.renderMap(world, t, layout, core.composeSheet(pieces, layout, t), pieces).data;
  };
  assert.deepEqual(paint('dual-binary'), paint('dual-standard'));
  assert.deepEqual(paint('blob-sorted'), paint('blob-godot'));
  assert.deepEqual(paint('minimal'), paint('blob-godot'), 'non-autotile layouts draw straight from the pieces');
});

test('a dual map puts each tile half a cell off the grid', () => {
  const t = 16;
  const pieces = core.guidePieces(t);
  const layout = core.layoutById('dual-standard');
  const world = core.worldFromText(['...', '.#.', '...']);
  const map = core.renderMap(world, t, layout, core.composeSheet(pieces, layout, t), pieces);
  const alpha = (x, y) => map.data[(y * map.width + x) * 4 + 3];
  assert.ok(alpha(24, 24) > 0, 'the filled cell is drawn');
  assert.equal(alpha(4, 4), 0, 'a far corner is empty');
});

test('Godot tilesets name every tile and paint the right peering bits', () => {
  const opts = { tileSize: 16, texturePath: 'res://tiles/sand.png', terrainName: 'Sand' };
  const blob = core.godotTileSet(core.layoutById('blob-godot'), opts);
  assert.match(blob, /terrain_set_0\/mode = 0/);
  assert.equal(blob.match(/\/terrain = 0/g).length, 47);
  assert.match(blob, /path="res:\/\/tiles\/sand.png"/);
  // (9,2) is the full tile: all eight bits.
  assert.equal(blob.match(/^9:2\/0\/terrains_peering_bit\//gm).length, 8);
  const dual = core.godotTileSet(core.layoutById('dual-standard'), opts);
  assert.match(dual, /terrain_set_0\/mode = 1/);
  assert.equal(dual.match(/\/terrain = 0/g).length, 15, 'the empty tile has no terrain');
  assert.match(dual, /^2:1\/0\/terrains_peering_bit\/top_left_corner = 0$/m);
  const sides = core.godotTileSet(core.layoutById('sides-16'), opts);
  assert.match(sides, /terrain_set_0\/mode = 2/);
  assert.doesNotMatch(sides, /_corner/);
  assert.equal(core.godotTileSet(core.layoutById('ring'), opts), null);
});

test('opaque images have their background colour keyed out', () => {
  const img = core.createImage(4, 4);
  for (let i = 0; i < 16; i++) img.data.set(i === 5 ? [10, 20, 30, 255] : [255, 255, 255, 255], i * 4);
  assert.ok(!core.hasTransparency(img));
  assert.ok(core.isBackdrop(img, core.borderColour(img)));
  const keyed = core.keyOut(img, core.borderColour(img));
  assert.equal(keyed.data[5 * 4 + 3], 255);
  assert.equal(keyed.data[3], 0);
});

test('PNGs survive a write and read', () => {
  const img = core.composeSheet(core.guidePieces(16), core.layoutById('dual-standard'), 16);
  assert.deepEqual(decodePng(encodePng(img)).data, img.data);
});
