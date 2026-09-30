#!/usr/bin/env node
// Convert a tileset image from the command line: the same conversion as the
// web page, writing every layout (and a Godot .tres for each autotile sheet).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import * as core from './src/core.js';
import { decodePng, encodePng } from './tools/png.mjs';

const USAGE = `Usage: node cli.mjs <image.png> [options]

  --read MODE       how to read the image: auto (default), dual, terrain,
                    or a layout id: ${core.LAYOUTS.map((l) => l.id).join(', ')}
  --tile N          tile size in pixels (default: work it out)
  --out DIR         where to write the results (default: out)
  --only IDS        comma-separated layout ids to write (default: all)
  --godot-dir DIR   where the sheets will live in your Godot project,
                    for the .tres files (default: res://tiles/)
  --terrain NAME    the terrain's name in Godot (default: Terrain)
  --swap            for tiles on a solid background (grass on water, say),
                    swap which colour is the terrain and which the background
  --keep-border     for an image with no transparency, keep its border colour
                    rather than treating it as transparent
  --fill X,Y        take the foreground fill (the plain middle of the terrain)
                    from the tile at column X, row Y, counting from 0
  --background X,Y  take the background fill from the tile at column X, row Y
  --blank           write blank templates instead of converting an image
                    (needs --tile; no image argument)`;

function parseArgs(argv) {
  const args = { read: 'auto', tile: 0, out: 'out', only: null, godotDir: 'res://tiles/', terrain: 'Terrain', blank: false, swap: false, keepBorder: false, fill: null, background: null, input: null };
  const tileAt = (flag, value) => {
    const m = /^(\d+),(\d+)$/.exec(value);
    if (!m) throw new Error(`${flag} takes a tile's column and row, like 2,4.`);
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--read') args.read = next();
    else if (a === '--tile') args.tile = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--only') args.only = next().split(',');
    else if (a === '--godot-dir') args.godotDir = next();
    else if (a === '--terrain') args.terrain = next();
    else if (a === '--blank') args.blank = true;
    else if (a === '--swap') args.swap = true;
    else if (a === '--keep-border') args.keepBorder = true;
    else if (a === '--fill') args.fill = tileAt(a, next());
    else if (a === '--background') args.background = tileAt(a, next());
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else args.input = a;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.input && !args.blank)) {
    console.log(USAGE);
    return;
  }
  let pieces, tileSize, name;
  if (args.blank) {
    if (!args.tile) throw new Error('--blank needs --tile.');
    tileSize = args.tile;
    pieces = core.guidePieces(tileSize);
    name = 'template';
  } else {
    let img = decodePng(readFileSync(args.input));
    if (!core.hasTransparency(img) && !args.keepBorder) {
      const border = core.borderColour(img);
      if (core.isBackdrop(img, border)) img = core.keyOut(img, border);
    }
    const plain = args.fill || args.background ? { fill: args.fill, background: args.background } : null;
    const source = core.readSource(img, { read: args.read, tileSize: args.tile, swap: args.swap, plain });
    ({ pieces, tileSize } = source);
    name = basename(args.input, extname(args.input));
    const s = core.summarise(pieces);
    const hex = (rgb) => '#' + rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    console.log(`Read ${args.input} as ${source.read === 'dual' ? 'dual-grid tiles' : source.read === 'terrain' ? 'a terrain drawing' : source.read}, ${tileSize}px tiles.`);
    if (source.split) console.log(`The tiles sit on a solid background: ${hex(source.split.terrain)} is the terrain and ${hex(source.split.background)} the background${args.swap ? ' (swapped)' : ' (--swap to swap them)'}.`);
    console.log(`Terrain pieces: ${s.terrain.found} found, ${s.terrain.adapted} mirrored, ${s.terrain.madeUp} made up, ${s.terrain.missing} missing.`);
    console.log(`Overhang pieces: ${s.overhang.found} found, ${s.overhang.adapted} mirrored, ${s.overhang.madeUp} made up, ${s.overhang.missing} missing.`);
    if (s.flatFill) console.log(`No fill tile in the image, so the fill is flat ${hex(s.flatFill)}.`);
    if (s.flatBackground) console.log(`No plain background tile in the image, so the background is flat ${hex(s.flatBackground)}.`);
  }
  mkdirSync(args.out, { recursive: true });
  const dir = args.godotDir.endsWith('/') ? args.godotDir : args.godotDir + '/';
  for (const layout of core.LAYOUTS) {
    if (args.only && !args.only.includes(layout.id)) continue;
    const file = `${name}_${layout.file}`;
    writeFileSync(join(args.out, file + '.png'), encodePng(core.composeSheet(pieces, layout, tileSize)));
    const tres = core.godotTileSet(layout, { tileSize, texturePath: dir + file + '.png', terrainName: args.terrain });
    if (tres) writeFileSync(join(args.out, file + '.tres'), tres);
    console.log(`  ${file}.png${tres ? ' + .tres' : ''}  (${layout.name})`);
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
