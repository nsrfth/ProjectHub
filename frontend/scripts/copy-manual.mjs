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
const repoRoot = resolve(__dirname, '..', '..');
const publicDir = resolve(__dirname, '..', 'public');

// v1.13: copy both manuals so HelpPage can fetch by active language.
// The repo-root files remain canonical; these are runtime mirrors. The
// Persian (.fa.md) file is optional — warn but don't fail if missing.
const SOURCES = [
  { name: 'USER_MANUAL.md', required: true },
  { name: 'USER_MANUAL.fa.md', required: false },
];

mkdirSync(publicDir, { recursive: true });
for (const { name, required } of SOURCES) {
  const from = resolve(repoRoot, name);
  if (!existsSync(from)) {
    if (required) {
      console.error(`copy-manual: required source missing at ${from}`);
      process.exit(1);
    }
    console.warn(`copy-manual: optional source missing at ${from} — skipping`);
    continue;
  }
  const to = resolve(publicDir, name);
  copyFileSync(from, to);
  console.log(`copy-manual: ${from} -> ${to}`);
}
