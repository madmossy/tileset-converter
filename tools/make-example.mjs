#!/usr/bin/env node
// Draws examples/dual-example.png from tools/example-art.mjs: original
// placeholder terrain in the dual-grid example layout, generated from simple
// geometry so the image is free to share with the project.
//
//   node tools/make-example.mjs [tile size, default 16]
import { writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';
import { exampleImage } from './example-art.mjs';

const T = Number(process.argv[2]) || 16;
const image = exampleImage(T);
const out = new URL('../examples/dual-example.png', import.meta.url);
writeFileSync(out, encodePng(image));
console.log(`Wrote ${out.pathname} (${image.width}x${image.height}, ${T}px tiles).`);
