// Pre-build sync: copy the canonical USER_MANUAL.md from the repo root into
// frontend/public so Vite ships it in dist. Keeping a single source of truth
// at the repo root means GitHub renders the manual + the in-app /help route
// renders the SAME content, without an editor having to remember to update
// two files.
//
// Run automatically before `npm run build` via the `prebuild` script hook.
// During dev (`vite`), the file under public/ is whichever copy was last
// produced — re-run `npm run sync-manual` after editing the root file if you
// want the live dev server to reflect the change.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, '..', '..', 'USER_MANUAL.md');
const dest = resolve(__dirname, '..', 'public', 'USER_MANUAL.md');

if (!existsSync(src)) {
  console.error(`copy-manual: source missing at ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copy-manual: ${src} -> ${dest}`);
