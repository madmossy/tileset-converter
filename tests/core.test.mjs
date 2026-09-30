import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../src/core.js';
import { decodePng, encodePng } from '../tools/png.mjs';

const example = () => decodePng(readFileSync(new URL('../examples/dual-example.png', import.meta.url)));

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
  for (const id of ['blob-godot', 'blob-emberkin']) {
    const keys = core.layoutById(id).slots.map((s) => s.key);
    assert.equal(keys.length, 47, id);
    assert.deepEqual([...keys].sort((a, b) => a - b), all, id);
  }
});

test('the Emberkin sheet uses the same slots as tools/Blob47.gd', () => {
  const layout = core.layoutById('blob-emberkin');
  // Blob47.gd: slot i holds masks()[i], 8 per row. Spot-check its named tiles.
  const slotOf = (mask) => layout.slots.find((s) => s.key === mask);
  assert.deepEqual([slotOf(0).x, slotOf(0).y], [0, 0]);
  assert.deepEqual([slotOf(255).x, slotOf(255).y], [6, 5]);
  assert.ok(!layout.slots.some((s) => s.x === 7 && s.y === 5), 'slot (7,5) is reserved');
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

test('painting a map gives the same picture whichever sheet of a family is used', () => {
  const t = 16;
  const pieces = distinctPieces(t / 2);
  const world = core.worldFromText(core.DEMO_WORLD);
  const paint = (id) => {
    const layout = core.layoutById(id);
    return core.renderMap(world, t, layout, core.composeSheet(pieces, layout, t), pieces).data;
  };
  assert.deepEqual(paint('dual-binary'), paint('dual-standard'));
  assert.deepEqual(paint('blob-emberkin'), paint('blob-godot'));
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
  const keyed = core.keyOut(img, core.borderColour(img));
  assert.equal(keyed.data[5 * 4 + 3], 255);
  assert.equal(keyed.data[3], 0);
});

test('PNGs survive a write and read', () => {
  const img = core.composeSheet(core.guidePieces(16), core.layoutById('dual-standard'), 16);
  assert.deepEqual(decodePng(encodePng(img)).data, img.data);
});
