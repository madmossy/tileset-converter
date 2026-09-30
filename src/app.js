// The web page: loads an image, runs the core conversion, and draws the results.
import * as core from './core.js';

const $ = (selector) => document.querySelector(selector);

const HOW_TEXT = {
  found: (p) => (p.from && p.from.x !== undefined ? `Found in tile (${p.from.x}, ${p.from.y})` : 'Found'),
  mirrored: (p) => `Mirrored from the ${core.POSITION_NAMES[p.from.pos]} one`,
  copied: (p) => `Copied from the ${core.POSITION_NAMES[p.from.pos]} one`,
  flat: (p, kind) => (kind === core.EMPTY_KIND ? 'No plain background in your image: a flat colour' : 'No fill in your image: a flat colour'),
  'stand-in': () => 'Not in your image: using the fill instead',
  layered: (p) => `Not in your image: layered from ${p.from.kinds.map((k) => core.KIND_NAMES[k].toLowerCase()).join(' + ')}`,
};
const HOW_CLASS = { found: 'found', mirrored: 'adapted', copied: 'adapted', flat: 'made', 'stand-in': 'made', layered: 'made' };
const KIND_PLURALS = { outer: 'outer corners', hedge: 'top or bottom edges', vedge: 'side edges', inner: 'inner corners' };
const PICK_HINTS = {
  dual: 'Dual-grid tiles sit where four cells meet, so each corner of a tile is the middle of a cell. ',
  blob: 'Blob tiles each sit on one cell: here, a 3×3 island and the four inner corners around a hole. ',
};
const PICK_HOW = 'Click a slot, then the tile in your image that goes in it. The two slots marked with a dot are enough on their own: the rest are mirrored from them, so fill more in if your art is lit from one side.';

const state = {
  raw: null,
  img: null,
  name: 'tileset',
  read: 'auto',
  tileSize: 0,
  key: null,
  keyOn: true,
  swap: false,
  auto: null, // the automatic reading, kept for picking by hand
  autoError: null,
  autoFor: null,
  pick: { family: 'dual', picks: { dual: new Map(), blob: new Map() }, selected: null, hover: null, size: 0 },
  sourceScale: 1,
  source: null,
  error: null,
  show: 'tiles',
  world: core.worldFromText(core.DEMO_WORLD),
  paint: 'dual-standard',
  grid: true,
  mapCell: 16,
};

const cards = new Map();
const guideCache = new Map();

init();

function init() {
  const readSelect = $('#read-mode');
  const drawn = document.createElement('optgroup');
  drawn.label = 'An example you drew';
  for (const mode of core.READ_MODES) drawn.append(new Option(mode.name, mode.id));
  const sheets = document.createElement('optgroup');
  sheets.label = 'A finished sheet in this layout';
  for (const layout of core.LAYOUTS) sheets.append(new Option(layout.name, layout.id));
  const other = document.createElement('optgroup');
  other.label = 'Anything else';
  other.append(new Option('Let me pick the tiles', 'pick'));
  readSelect.append(drawn, sheets, other);

  const paintSelect = $('#paint-layout');
  for (const layout of core.LAYOUTS.filter((l) => l.paintable)) paintSelect.append(new Option(layout.name, layout.id));

  buildCards();
  wire();
  update();
}

function wire() {
  const file = $('#file');
  const choose = () => file.click();
  $('#choose').addEventListener('click', choose);
  $('#choose-again').addEventListener('click', choose);
  file.addEventListener('change', () => {
    if (file.files[0]) loadBlob(file.files[0], file.files[0].name);
    file.value = '';
  });
  $('#load-example').addEventListener('click', loadExample);
  $('#load-example-again').addEventListener('click', loadExample);

  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) loadBlob(f, f.name);
  });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
    if (item) loadBlob(item.getAsFile(), 'pasted');
  });

  $('#read-mode').addEventListener('change', (e) => { state.read = e.target.value; analyse(); update(); });
  $('#tile-size').addEventListener('change', (e) => {
    const v = Math.round(Number(e.target.value));
    state.tileSize = Number.isFinite(v) && v >= 2 ? v : 0;
    if (!state.tileSize) e.target.value = '';
    analyse();
    update();
  });
  $('#key-on').addEventListener('change', (e) => { state.keyOn = e.target.checked; analyse(); update(); });

  for (const button of document.querySelectorAll('.seg button[data-show]')) {
    button.addEventListener('click', () => { state.show = button.dataset.show; update(); });
  }
  wirePicking();

  $('#paint-layout').addEventListener('change', (e) => { state.paint = e.target.value; renderMap(); });
  $('#show-grid').addEventListener('change', (e) => { state.grid = e.target.checked; renderMap(); });
  $('#reset-map').addEventListener('click', () => { state.world = core.worldFromText(core.DEMO_WORLD); renderMap(); });
  $('#clear-map').addEventListener('click', () => { state.world.cells.fill(0); renderMap(); });
  wireMapPainting();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(update, 120);
  });
}

// ---------------------------------------------------------------------------
// Loading

async function loadExample() {
  try {
    const response = await fetch('examples/dual-example.png');
    if (!response.ok) throw new Error(response.statusText);
    await loadBlob(await response.blob(), 'dual-example.png');
  } catch {
    state.error = 'Couldn’t load the example. If you opened this file straight from disk, run it from a web server (see the README).';
    update();
  }
}

async function loadBlob(blob, name) {
  try {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    state.raw = { width: data.width, height: data.height, data: data.data };
    state.name = (name || 'tileset').replace(/\.[^.]+$/, '') || 'tileset';
    state.key = core.hasTransparency(state.raw) ? null : core.borderColour(state.raw);
    state.keyOn = !state.key || core.isBackdrop(state.raw, state.key);
    $('#key-on').checked = state.keyOn;
    state.swap = false;
    state.autoFor = null;
    resetPicks();
    state.show = 'tiles';
  } catch {
    state.raw = null;
    state.error = 'That file couldn’t be opened as an image.';
    update();
    return;
  }
  analyse();
  update();
}

function analyse() {
  state.source = null;
  state.error = null;
  if (!state.raw) return;
  state.img = state.key && state.keyOn ? core.keyOut(state.raw, state.key) : state.raw;
  // The automatic reading: shown as it is for 'auto', and its tile size is
  // the starting grid for picking by hand.
  const autoFor = [state.keyOn, state.swap, state.tileSize].join();
  if (state.autoFor !== autoFor) {
    state.autoFor = autoFor;
    try {
      state.auto = core.readSource(state.img, { tileSize: state.tileSize, swap: state.swap });
      state.autoError = null;
    } catch (err) {
      state.auto = null;
      state.autoError = err.message;
    }
  }
  if (state.read === 'auto') {
    state.source = state.auto;
    state.error = state.autoError;
  } else if (state.read === 'pick') {
    readPicks();
  } else {
    try {
      state.source = core.readSource(state.img, { read: state.read, tileSize: state.tileSize, swap: state.swap });
    } catch (err) {
      state.error = err.message;
    }
  }
}

/** The pieces the outputs are built from: the source's, or blank placeholders. */
function current() {
  const t = state.source?.tileSize || (state.read === 'pick' && state.raw ? pickTileSize() : state.tileSize) || 16;
  if (state.show === 'tiles' && state.source) return { pieces: state.source.pieces, t, blank: false };
  return { pieces: guidePiecesFor(t), t, blank: true };
}

function guidePiecesFor(t) {
  if (!guideCache.has(t)) guideCache.set(t, core.guidePieces(t));
  return guideCache.get(t);
}

// ---------------------------------------------------------------------------
// Picking tiles by hand

/** The grid picks are made on: the tile size you set, or the one it found. */
function pickTileSize() {
  return state.tileSize || state.auto?.tileSize || 16;
}

function resetPicks() {
  const p = state.pick;
  p.picks.dual.clear();
  p.picks.blob.clear();
  p.selected = core.PICK_BOARDS[p.family].minimum[0];
  p.hover = null;
}

/** The source, from the tiles picked so far; none yet means no source. */
function readPicks() {
  const p = state.pick;
  const t = pickTileSize();
  if (p.size !== t) {
    // On a different grid, the old picks point at the wrong pixels.
    p.size = t;
    p.picks.dual.clear();
    p.picks.blob.clear();
  }
  const picks = [...p.picks[p.family]].map(([key, at]) => ({ key, ...at }));
  if (!picks.length) return;
  try {
    state.source = core.readPicked(state.img, { family: p.family, tileSize: t, picks });
  } catch (err) {
    state.error = err.message;
  }
}

/** After a pick: the next empty slot, the two needed ones first. */
function nextSlot() {
  const p = state.pick;
  const board = core.PICK_BOARDS[p.family];
  const picks = p.picks[p.family];
  const needed = board.minimum.find((key) => !picks.has(key));
  if (needed !== undefined) return needed;
  const keys = board.slots.map((slot) => slot.key);
  const from = keys.indexOf(p.selected);
  for (let i = 1; i <= keys.length; i++) {
    const key = keys[(from + i) % keys.length];
    if (!picks.has(key)) return key;
  }
  return p.selected;
}

function wirePicking() {
  const p = state.pick;
  for (const button of document.querySelectorAll('#pick .seg button')) {
    button.addEventListener('click', () => {
      if (p.family === button.dataset.family) return;
      p.family = button.dataset.family;
      p.selected = nextSlot();
      analyse();
      update();
    });
  }
  $('#pick-clear').addEventListener('click', () => {
    p.picks[p.family].delete(p.selected);
    analyse();
    update();
  });
  $('#pick-clear-all').addEventListener('click', () => {
    p.picks[p.family].clear();
    p.selected = nextSlot();
    analyse();
    update();
  });
  const view = $('#source-view');
  const tileAt = (e) => {
    const t = pickTileSize();
    const size = t * state.sourceScale;
    const x = Math.floor(e.offsetX / size), y = Math.floor(e.offsetY / size);
    return x >= 0 && y >= 0 && x < Math.floor(state.img.width / t) && y < Math.floor(state.img.height / t) ? { x, y } : null;
  };
  const same = (a, b) => (a && b ? a.x === b.x && a.y === b.y : a === b);
  view.addEventListener('click', (e) => {
    if (state.read !== 'pick' || !state.img || p.selected === null) return;
    const at = tileAt(e);
    if (!at) return;
    p.picks[p.family].set(p.selected, at);
    p.selected = nextSlot();
    analyse();
    update();
  });
  view.addEventListener('pointermove', (e) => {
    if (state.read !== 'pick' || !state.img) return;
    const at = tileAt(e);
    if (same(at, p.hover)) return;
    p.hover = at;
    renderSource();
  });
  view.addEventListener('pointerleave', () => {
    if (!p.hover) return;
    p.hover = null;
    renderSource();
  });
}

// ---------------------------------------------------------------------------
// Drawing helpers

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toCanvas(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  if (img.width && img.height) canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return canvas;
}

/** Draw img into canvas at a whole-number zoom that fits, with an optional
 *  tile grid and overlay. Returns the zoom used. */
function paint(canvas, img, { maxWidth, maxHeight = Infinity, maxScale = 12, grid = 0, offset = 0, overlay = null }) {
  let scale = Math.min(maxScale, Math.floor(maxWidth / img.width), Math.floor(maxHeight / img.height));
  if (scale < 1) scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(toCanvas(img), 0, 0, w, h);
  if (grid) {
    const step = grid * scale;
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (offset * scale) % step; x <= w + 0.5; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (let y = (offset * scale) % step; y <= h + 0.5; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  }
  if (overlay) overlay(ctx, scale);
  return scale;
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function hex(rgb) {
  return '#' + rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Rendering

function update() {
  renderSource();
  renderStatus();
  renderPick();
  renderPieces();
  for (const button of document.querySelectorAll('.seg button[data-show]')) button.setAttribute('aria-pressed', String(button.dataset.show === state.show));
  renderCards();
  renderMap();
}

function renderSource() {
  const has = !!state.raw;
  $('#drop-empty').hidden = has;
  $('#source-wrap').hidden = !has;
  $('#key-row').hidden = !state.key;
  if (state.key) $('#key-swatch').style.background = hex(state.key);
  if (!has) return;
  const canvas = $('#source-view');
  const box = $('#drop').clientWidth - 36;
  const src = state.source;
  const picking = state.read === 'pick';
  canvas.classList.toggle('picking', picking);
  state.sourceScale = paint(canvas, state.img, {
    maxWidth: Math.max(120, box),
    maxHeight: 460,
    grid: picking ? pickTileSize() : src ? src.tileSize : 0,
    overlay: (ctx, s) => {
      if (src) drawSourceMarks(ctx, s, src);
      if (picking) drawPickMarks(ctx, s);
    },
  });
}

/** Outline the picked tiles, the selected slot's boldest, and the tile under the pointer. */
function drawPickMarks(ctx, s) {
  const t = pickTileSize() * s;
  const p = state.pick;
  ctx.strokeStyle = css('--accent');
  for (const [key, at] of p.picks[p.family]) {
    const selected = key === p.selected;
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.setLineDash(selected ? [] : [4, 3]);
    ctx.strokeRect(at.x * t + 2, at.y * t + 2, t - 4, t - 4);
  }
  ctx.setLineDash([]);
  if (p.hover) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeRect(p.hover.x * t + 1.5, p.hover.y * t + 1.5, t - 3, t - 3);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(p.hover.x * t + 1.5, p.hover.y * t + 1.5, t - 3, t - 3);
  }
}

function renderPick() {
  const on = state.read === 'pick' && !!state.raw;
  $('#pick').hidden = !on;
  if (!on) return;
  const p = state.pick;
  const board = core.PICK_BOARDS[p.family];
  const picks = p.picks[p.family];
  for (const button of document.querySelectorAll('#pick .seg button')) button.setAttribute('aria-pressed', String(button.dataset.family === p.family));
  $('#pick-hint').textContent = PICK_HINTS[p.family] + PICK_HOW;
  const t = pickTileSize();
  const zoom = Math.max(1, Math.round(44 / t));
  const missing = state.source ? core.missingKinds(state.source.pieces) : Object.keys(KIND_PLURALS);
  const box = $('#pick-board');
  box.style.gridTemplateColumns = `repeat(${board.cols}, max-content)`;
  box.replaceChildren();
  for (const slot of board.slots) {
    const at = picks.get(slot.key);
    const recipe = core.recipeFor(board, slot.key);
    const needed = !at && board.minimum.includes(slot.key) && recipe.some((part) => missing.includes(part.kind));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick-slot' + (at ? '' : ' empty');
    button.style.gridColumn = String(slot.x + 1);
    button.style.gridRow = String(slot.y + 1);
    button.setAttribute('aria-pressed', String(slot.key === p.selected));
    const what = core.describeSlot(board, slot.key);
    button.title = `${what}${at ? `. Tile (${at.x}, ${at.y})` : ''}`;
    button.setAttribute('aria-label', `${what}. ${at ? `Tile (${at.x}, ${at.y})` : 'Empty'}${needed ? '. Needed' : ''}`);
    const tile = core.createImage(t, t);
    if (at) core.blitRegion(state.img, at.x * t, at.y * t, t, t, tile, 0, 0);
    else core.drawTile(tile, guidePiecesFor(t), recipe, 0, 0, t);
    const canvas = toCanvas(tile);
    canvas.className = 'checker';
    canvas.style.width = canvas.style.height = t * zoom + 'px';
    button.append(canvas);
    if (needed) button.append(Object.assign(document.createElement('span'), { className: 'need' }));
    button.addEventListener('click', () => {
      p.selected = slot.key;
      renderPick();
      renderSource();
    });
    box.append(button);
  }
  const at = picks.get(p.selected);
  const what = p.selected === null ? '' : core.describeSlot(board, p.selected);
  $('#pick-readout').textContent = p.selected === null ? '' : at
    ? `${what}: tile (${at.x}, ${at.y}). Click another tile in your image to change it.`
    : `${what}: click its tile in your image.`;
  $('#pick-clear').disabled = !at;
  $('#pick-clear-all').disabled = !picks.size;
}

/** Mark what the reading found: filled corners on dual tiles, filled cells on a drawing. */
function drawSourceMarks(ctx, s, src) {
  const t = src.tileSize * s;
  const accent = css('--accent');
  ctx.lineWidth = 1.5;
  if (src.read === 'dual' || (src.read === 'picked' && src.family === 'dual')) {
    const r = Math.max(2.5, t * 0.07);
    for (const tile of src.tiles) {
      for (let i = 0; i < 4; i++) {
        if (!((tile.key >> i) & 1)) continue;
        const cx = (tile.x + (i & 1 ? 0.82 : 0.18)) * t;
        const cy = (tile.y + (i & 2 ? 0.82 : 0.18)) * t;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }
  } else if (src.read === 'terrain') {
    ctx.strokeStyle = accent;
    ctx.setLineDash([4, 3]);
    for (const tile of src.tiles) ctx.strokeRect(tile.x * t + 3.5, tile.y * t + 3.5, t - 7, t - 7);
    ctx.setLineDash([]);
  }
}

function statusLine(text, tone = '') {
  const p = document.createElement('p');
  p.className = 'line' + (tone ? ' ' + tone : '');
  p.textContent = text;
  return p;
}

function renderStatus() {
  const box = $('#status');
  box.replaceChildren();
  if (state.error) {
    box.append(statusLine(state.error, 'bad'));
    return;
  }
  if (!state.source && state.raw && state.read === 'pick') {
    box.append(statusLine(`Pick your tiles below, on a grid of ${pickTileSize()}px tiles. If the grid doesn't line up with your tiles, set the tile size. Until you pick some, the layouts show blank templates.`));
    return;
  }
  if (!state.source) {
    box.append(statusLine('No image yet. Until you add one, the layouts below show blank templates you can draw over.'));
    return;
  }
  const src = state.source;
  const s = core.summarise(src.pieces);
  if (src.read === 'picked') {
    const n = src.tiles.length;
    const overhang = src.family === 'dual' ? ` and ${s.overhang.found} of the ${s.overhang.total} overhang pieces` : '';
    box.append(statusLine(`Using the ${n} tile${n === 1 ? '' : 's'} you picked, with ${src.tileSize}px tiles. Found ${s.terrain.found} of the ${s.terrain.total} terrain pieces${overhang}.`));
    const missing = core.missingKinds(src.pieces);
    if (missing.length) box.append(statusLine(`None of your tiles shows ${listOf(missing.map((kind) => KIND_PLURALS[kind]))} yet, so the fill stands in for them. Fill in a slot marked with a dot.`, 'warn'));
  } else {
    const how = src.read === 'dual' ? 'dual-grid tiles' : src.read === 'terrain' ? 'a drawing of terrain' : `a ${core.layoutById(src.read).name} sheet`;
    box.append(statusLine(`Read as ${how}, with ${src.tileSize}px tiles${state.read === 'auto' ? ' (worked out automatically)' : ''}. Found ${s.terrain.found} of the ${s.terrain.total} terrain pieces and ${s.overhang.found} of the ${s.overhang.total} overhang pieces.`));
    if (src.split) box.append(splitLine(src.split));
  }
  if (s.flatBackground) {
    box.append(statusLine(`There's no plain background tile in your image, so away from the terrain the background is flat ${hex(s.flatBackground)}.`, 'warn'));
  }
  if (s.flatFill) {
    box.append(statusLine(`There's no fill tile in your image, so the middle of the terrain is flat ${hex(s.flatFill)}. Add a solid tile somewhere in the image to use real texture there.`, 'warn'));
  }
  const standIns = s.terrain.madeUp - (s.flatFill ? 4 : 0);
  if (standIns > 0 && src.read !== 'picked') box.append(statusLine(`${standIns} terrain pieces weren't in your image and use the fill instead. Open "The pieces it found" to see which.`, 'warn'));
  if (s.terrain.adapted > 0) box.append(statusLine(`${s.terrain.adapted} terrain pieces were mirrored from another corner. Check they still look right if your art has lighting from one side.`, 'warn'));
}

function listOf(items) {
  return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}

/** For art on a solid background: which colour was taken as the terrain, and
 *  a button to swap it with the background. */
function splitLine(split) {
  const line = statusLine('');
  const swatch = (rgb) => {
    const span = document.createElement('span');
    span.className = 'swatch';
    span.style.background = hex(rgb.map(Math.round));
    return span;
  };
  const swap = document.createElement('button');
  swap.type = 'button';
  swap.className = 'secondary small';
  swap.textContent = 'Swap them';
  swap.addEventListener('click', () => { state.swap = !state.swap; analyse(); update(); });
  line.append('Your tiles sit on a solid background, so it told them apart by colour: ', swatch(split.terrain), ' is the terrain and ', swatch(split.background), ' is the background. ', swap);
  return line;
}

function renderPieces() {
  const box = $('#pieces');
  box.replaceChildren();
  const { pieces } = current();
  const half = pieces.half;
  const zoom = Math.max(1, Math.min(4, Math.floor(40 / half)));
  box.append(Object.assign(document.createElement('span'), { className: 'head' }));
  for (const name of core.POSITION_NAMES) box.append(Object.assign(document.createElement('span'), { className: 'head', textContent: name }));
  for (const kind of core.ALL_KINDS) {
    // See-through art has nothing to show as a background, so leave that row out.
    if (kind === core.EMPTY_KIND && !hasVisible(pieces, kind)) continue;
    box.append(Object.assign(document.createElement('span'), { className: 'kind', textContent: core.KIND_NAMES[kind] }));
    for (let pos = 0; pos < 4; pos++) {
      const piece = pieces.get(pos, kind);
      const canvas = document.createElement('canvas');
      canvas.className = 'checker ' + (piece ? HOW_CLASS[piece.how] : 'missing');
      canvas.width = half;
      canvas.height = half;
      canvas.style.width = canvas.style.height = half * zoom + 'px';
      canvas.style.backgroundSize = `${Math.max(4, zoom * 2)}px ${Math.max(4, zoom * 2)}px`;
      if (piece) canvas.getContext('2d').putImageData(new ImageData(piece.pixels.slice(), half, half), 0, 0);
      canvas.title = piece ? HOW_TEXT[piece.how](piece, kind) : 'Not in your image: drawn empty';
      box.append(canvas);
    }
  }
}

function hasVisible(pieces, kind) {
  return [0, 1, 2, 3].some((pos) => {
    const px = pieces.get(pos, kind)?.pixels;
    return px && px.some((v, i) => i % 4 === 3 && v >= 128);
  });
}

/** True if any overhang piece shows something besides the plain background. */
function hasOverhangArt(pieces) {
  for (const kind of core.OVERHANG_KINDS) {
    for (let pos = 0; pos < 4; pos++) {
      const p = pieces.get(pos, kind);
      if (!p || p.how !== 'found') continue;
      const base = pieces.get(pos, core.EMPTY_KIND)?.pixels;
      for (let i = 0; i < p.pixels.length; i += 4) {
        if (p.pixels[i + 3] < 128) continue;
        if (!base || [0, 1, 2, 3].some((k) => p.pixels[i + k] !== base[i + k])) return true;
      }
    }
  }
  return false;
}

function buildCards() {
  const box = $('#cards');
  for (const layout of core.LAYOUTS) {
    const card = document.createElement('article');
    card.className = 'card' + (layout.cols >= 8 ? ' wide' : '');
    const kindLabel = layout.family === 'dual' ? 'Dual grid' : layout.godot === 'sides' ? 'Match Sides' : layout.godot ? 'Blob' : 'Source sheet';
    card.innerHTML = `
      <header><h3></h3><span class="badge${layout.family === 'dual' ? ' dual' : ''}"></span></header>
      <p class="blurb"></p>
      <div class="sheet"><canvas class="checker"></canvas></div>
      <p class="readout"></p>
      <p class="note" hidden></p>
      <div class="button-row"><button type="button" data-act="png">Download PNG</button></div>`;
    card.querySelector('h3').textContent = layout.name;
    card.querySelector('.badge').textContent = kindLabel;
    card.querySelector('.blurb').textContent = layout.blurb;
    const actions = card.querySelector('.button-row');
    if (layout.godot) {
      const tres = document.createElement('button');
      tres.type = 'button';
      tres.className = 'secondary';
      tres.dataset.act = 'tres';
      tres.textContent = 'Godot TileSet (.tres)';
      actions.append(tres);
    }
    box.append(card);
    const entry = { layout, card, canvas: card.querySelector('canvas'), readout: card.querySelector('.readout'), note: card.querySelector('.note'), scale: 1, t: 16 };
    const bySpot = new Map(layout.slots.map((slot) => [`${slot.x},${slot.y}`, slot]));
    const idle = 'Hover a tile to see what it’s for.';
    entry.readout.textContent = idle;
    entry.canvas.addEventListener('pointermove', (e) => {
      const size = entry.scale * entry.t;
      const x = Math.floor(e.offsetX / size), y = Math.floor(e.offsetY / size);
      const slot = bySpot.get(`${x},${y}`);
      entry.readout.textContent = slot ? `Tile (${x}, ${y}): ${core.describeSlot(layout, slot.key)}` : `Tile (${x}, ${y}): unused`;
    });
    entry.canvas.addEventListener('pointerleave', () => { entry.readout.textContent = idle; });
    actions.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'png') downloadPng(layout);
      if (act === 'tres') downloadTres(layout);
    });
    cards.set(layout.id, entry);
  }
}

function renderCards() {
  const { pieces, t, blank } = current();
  const overhang = !blank && hasOverhangArt(pieces);
  for (const entry of cards.values()) {
    const sheet = core.composeSheet(pieces, entry.layout, t);
    const width = entry.canvas.parentElement.clientWidth || 280;
    entry.t = t;
    entry.scale = paint(entry.canvas, sheet, { maxWidth: width, maxHeight: 420, maxScale: 8, grid: t });
    const trims = overhang && entry.layout.family === 'blob';
    entry.note.hidden = !trims;
    if (trims) entry.note.textContent = 'Your art spills past the edge of each cell. Blob tiles can only draw inside their own cell, so here the terrain is drawn a little smaller, with its whole edge inside the tile. The dual-grid layouts draw it exactly as it is.';
  }
}

function fileBase(layout) {
  const { blank } = current();
  return `${blank ? 'template' : state.name}_${layout.file}`.replace(/[^\w.-]+/g, '_');
}

function downloadPng(layout) {
  const { pieces, t } = current();
  toCanvas(core.composeSheet(pieces, layout, t)).toBlob((blob) => save(blob, fileBase(layout) + '.png'), 'image/png');
}

function downloadTres(layout) {
  const { t } = current();
  let dir = $('#godot-dir').value.trim() || 'res://';
  if (!dir.startsWith('res://')) dir = 'res://' + dir.replace(/^\/+/, '');
  if (!dir.endsWith('/')) dir += '/';
  const base = fileBase(layout);
  const text = core.godotTileSet(layout, { tileSize: t, texturePath: dir + base + '.png', terrainName: $('#terrain-name').value.trim() || 'Terrain' });
  save(new Blob([text], { type: 'text/plain' }), base + '.tres');
}

// ---------------------------------------------------------------------------
// Try it: a paintable map

function renderMap() {
  const { pieces, t } = current();
  const layout = core.layoutById(state.paint);
  const sheet = core.composeSheet(pieces, layout, t);
  const img = core.renderMap(state.world, t, layout, sheet, pieces);
  const width = $('#map-wrap').clientWidth || 600;
  const scale = paint($('#map'), img, { maxWidth: width, maxScale: 6, grid: state.grid ? t : 0 });
  state.mapCell = t * scale;
}

function wireMapPainting() {
  const canvas = $('#map');
  let painting = null;
  const cellAt = (e) => {
    const x = Math.floor(e.offsetX / state.mapCell), y = Math.floor(e.offsetY / state.mapCell);
    return x >= 0 && y >= 0 && x < state.world.w && y < state.world.h ? y * state.world.w + x : -1;
  };
  const set = (i) => {
    if (i < 0 || state.world.cells[i] === painting) return;
    state.world.cells[i] = painting;
    renderMap();
  };
  canvas.addEventListener('pointerdown', (e) => {
    const i = cellAt(e);
    if (i < 0) return;
    canvas.setPointerCapture(e.pointerId);
    painting = state.world.cells[i] ? 0 : 1;
    set(i);
  });
  canvas.addEventListener('pointermove', (e) => { if (painting !== null) set(cellAt(e)); });
  const stop = () => { painting = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
}
