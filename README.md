# Tileset Converter

Convert a terrain tileset from one layout to another: dual grid, Godot's blob-47 template, Match Sides, and a couple of hand-drawing formats. Give it one small example of your terrain and it builds every layout, each with a Godot 4 TileSet (`.tres`) whose terrain is already painted onto every tile.

**Use it here: https://madmossy.github.io/tileset-converter/**

It runs entirely in your browser. Your images never leave your computer.

## Using it

1. **Add your tiles.** Drop in a PNG, paste one, or try the example. It can be:
   - **A few dual-grid tiles in any arrangement**, like the example: a 3×3 block around a hole (inner corners and edges), a 2×2 block around an island (outer corners), and a solid tile for the fill. Without a fill tile, the middle of the terrain comes out as a flat colour.
   - **A drawing of terrain on the grid**, such as a 3×3 block with a hole in the middle.
   - **A finished sheet** in any of the layouts below.

   The converter works out the tile size and which kind it is. Dots on the preview show what it found. If it guesses wrong, set **Read it as** and **Tile size** yourself.
2. **Download the layouts you want.** Each card has the PNG, and the autotile layouts also have a Godot TileSet. Put the PNG in the folder named in *Where the PNGs will live*, then open the `.tres` in Godot.
3. **Try it.** Paint on the map at the bottom to see the sheet working the way a game would draw it.

Switch to **Blank templates** for empty versions of every layout to draw over.

## The layouts

| Layout | Tiles | Godot terrain mode | Notes |
| --- | --- | --- | --- |
| Dual grid · standard 4×4 | 16 | Match Corners | The layout from jess::codes' dual-grid tutorial and its Godot ports. Touching tiles share corners, so the sheet reads as one picture. |
| Dual grid · 4×4 by number | 16 | Match Corners | Tile *n* at column *n* % 4, row *n* / 4, where *n* = TL + 2·TR + 4·BL + 8·BR. |
| Blob 47 · Godot 12×4 template | 47 | Match Corners and Sides | Godot's classic 3×3-minimal template. |
| Blob 47 · sorted 8-column | 47 | Match Corners and Sides | Sorted by neighbour mask (N = 1, NE = 2, E = 4 … NW = 128), 8 to a row. Slot *i* holds the *i*-th mask. |
| Match Sides · 4×4 | 16 | Match Sides | Sides only, no inner corners. *n* = top + 2·right + 4·bottom + 8·left. |
| Minimal 6-tile | 6 | (source format) | A lone tile, four inner corners and a 2×2 block, like RPG Maker's A2. |
| 3×3 ring + fill | 9 | (source format) | A 3×3 block with a hole, plus a fill tile. |

### Dual grid in Godot

For true dual-grid painting (paint a cell and exactly that cell fills), use the **standard 4×4** sheet with a dual-grid script: a second TileMapLayer offset by half a tile, whose tiles are chosen from the four cells around each corner. The `.tres` also works with Godot's built-in **Match Corners** terrain, but that terrain lives on the corners *between* painted cells, so the terrain you see is the painted area shrunk by half a tile.

### Blob tiles can't overhang

A blob tile sits on its own cell, so it can't draw anything past that cell's edge. If your art spills over the edge (like the example's outline), the blob layouts cut that part off, and the page warns you. The dual-grid layouts keep it.

## How it works

Every tile in every layout is four quarter-tiles. A quarter belongs to one terrain cell, and how it looks depends only on three of that cell's neighbours: the one above or below it, the one beside it, and the diagonal.

- A **blob** tile sits on a cell: its quarters are that cell's own.
- A **dual-grid** tile sits where four cells meet: each quarter is the nearest quarter of a different cell. The quarters of *empty* cells carry any art that overhangs into them.

So the converter cuts your image into quarters, names each one by its neighbours, and glues them back together in every layout. That makes 20 kinds of quarter for filled cells (fill, outer corner, top/bottom edge, side edge and inner corner, at 4 positions) and 28 kinds of overhang.

When something isn't in your image, it fills the gap and says so in *The pieces it found*. It mirrors a piece from another corner, uses a flat fill colour when there's no fill tile, or layers two overhang pieces together.

To read an image it tries every tile size that fits, as both dual-grid tiles and a terrain drawing. For each reading it rebuilds the image from the pieces found and counts the pixels that come out wrong. The best reading, with the largest tiles, wins.

## Command line

The same converter runs in Node (20 or newer), with no dependencies:

```bash
node cli.mjs examples/dual-example.png --out out
```

Options: `--read auto|dual|terrain|<layout id>`, `--tile N`, `--only dual-standard,blob-godot`, `--godot-dir res://tiles/`, `--terrain Grass`, and `--blank --tile 16` for blank templates.

## Developing

```bash
npm test
```

The page is plain HTML and JavaScript modules, with no build step. Browsers won't load modules from a `file://` page, so to run it locally, serve the folder:

```bash
python -m http.server 8765
```

Then open http://localhost:8765.

- `src/core.js` holds the conversion (layouts, reading, pieces, composing, the Godot TileSet). It has no DOM code, so the page, the CLI and the tests share it.
- `src/app.js` and `src/style.css` are the page.
- `cli.mjs` and `tools/png.mjs` are the command line and its PNG reader/writer.
- `tools/make-example.mjs` draws `examples/dual-example.png` from simple geometry, so the example is original and free to share. Run `node tools/make-example.mjs 32` for a 32px version.
- `tests/core.test.mjs` holds the tests.

Every push runs the tests on GitHub Actions, and a green push to `main` publishes the site to GitHub Pages (`.github/workflows/pages.yml`).
