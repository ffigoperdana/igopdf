// Regenerate the igo favicon/PWA raster icons from public/images/favicon.svg.
// Run: node scripts/gen-icons.mjs   (needs devDeps: sharp, png-to-ico)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.resolve(root, '../public/images');
const publicDir = path.resolve(root, '../public');
const svg = await readFile(path.join(imgDir, 'favicon.svg'));

const png = (size) => sharp(svg, { density: 384 }).resize(size, size).png();

const targets = [
  [path.join(imgDir, 'favicon-192x192.png'), 192],
  [path.join(imgDir, 'favicon-512x512.png'), 512],
  [path.join(imgDir, 'apple-touch-icon.png'), 180],
  [path.join(imgDir, 'favicon.png'), 96],
];

for (const [file, size] of targets) {
  await png(size).toFile(file);
  console.log('wrote', path.basename(file), `${size}x${size}`);
}

// favicon.ico bundles 16/32/48 from the same glyph
const icoBuffers = await Promise.all(
  [16, 32, 48].map((s) => png(s).toBuffer())
);
await writeFile(path.join(publicDir, 'favicon.ico'), await pngToIco(icoBuffers));
console.log('wrote favicon.ico (16/32/48)');
