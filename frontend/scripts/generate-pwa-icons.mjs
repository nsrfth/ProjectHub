/**
 * Generate PWA icon PNGs from the Quad brand mark SVGs (matches BrandMark.tsx filled).
 * Run via prebuild so Docker and local builds always have icons in public/.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pwaDir = join(__dirname, 'pwa');
const outDir = join(root, 'public', 'icons');

const anySvg = readFileSync(join(pwaDir, 'brand-mark-filled.svg'));
const maskableSvg = readFileSync(join(pwaDir, 'brand-mark-maskable.svg'));

mkdirSync(outDir, { recursive: true });

await Promise.all([
  sharp(anySvg).resize(192, 192).png().toFile(join(outDir, 'pwa-192.png')),
  sharp(anySvg).resize(512, 512).png().toFile(join(outDir, 'pwa-512.png')),
  sharp(maskableSvg).resize(512, 512).png().toFile(join(outDir, 'pwa-512-maskable.png')),
  sharp(anySvg).resize(180, 180).png().toFile(join(outDir, 'apple-touch-icon.png')),
]);

console.log('generate-pwa-icons: wrote public/icons/*.png');
