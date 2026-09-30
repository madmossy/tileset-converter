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
  --blank           write blank templates instead of converting an image
                    (needs --tile; no image argument)`;

function parseArgs(argv) {
  const args = { read: 'auto', tile: 0, out: 'out', only: null, godotDir: 'res://tiles/', terrain: 'Terrain', blank: false, input: null };
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
    if (!core.hasTransparency(img)) img = core.keyOut(img, core.borderColour(img));
    const source = core.readSource(img, { read: args.read, tileSize: args.tile });
    ({ pieces, tileSize } = source);
    name = basename(args.input, extname(args.input));
    const s = core.summarise(pieces);
    console.log(`Read ${args.input} as ${source.read === 'dual' ? 'dual-grid tiles' : source.read === 'terrain' ? 'a terrain drawing' : source.read}, ${tileSize}px tiles.`);
    console.log(`Terrain pieces: ${s.terrain.found} found, ${s.terrain.adapted} mirrored, ${s.terrain.madeUp} made up, ${s.terrain.missing} missing.`);
    console.log(`Overhang pieces: ${s.overhang.found} found, ${s.overhang.adapted} mirrored, ${s.overhang.madeUp} made up, ${s.overhang.missing} missing.`);
    if (s.flatFill) console.log(`No fill tile in the image, so the fill is flat #${s.flatFill.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}.`);
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
