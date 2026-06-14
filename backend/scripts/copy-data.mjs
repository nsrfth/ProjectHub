import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/data');
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/data');
fs.cpSync(src, dest, { recursive: true });
console.log('copy-data: src/data -> dist/data');
