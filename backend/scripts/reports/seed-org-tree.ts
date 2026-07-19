/**
 * Phase 4 — org-tree seeding, driven ENTIRELY by an operator-supplied JSON
 * file. No org names are hardcoded (same discipline as seed-org-companies):
 * the tree is business data — D-2 (where ATS sits) is answered by whoever
 * writes the file, not by this script.
 *
 * File shape (array, order matters only for parent-before-child):
 *   [
 *     { "type": "HOLDING", "name": "Modal Alco",  "code": "MDL" },
 *     { "type": "HOLDING", "name": "SBC",         "code": "SBC" },
 *     { "type": "COMPANY", "name": "ATS",         "code": "ATS",  "parentCode": "MDL" },
 *     { "type": "SITE",    "name": "KVSM",        "code": "KVSM", "parentCode": "MDL" }
 *   ]
 *
 * Idempotent via @@unique([parentId, code]) — re-running never duplicates,
 * and existing nodes are matched by (parent, code) and left untouched (names
 * are NOT overwritten; the tree may have been hand-edited since).
 *
 * Usage
 * -----
 *   DATABASE_URL='...' npx tsx scripts/reports/seed-org-tree.ts tree.json           # dry run
 *   DATABASE_URL='...' npx tsx scripts/reports/seed-org-tree.ts tree.json --apply
 */

import { readFileSync } from 'node:fs';
import { PrismaClient, type OrgUnitType } from '@prisma/client';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const file = argv.find((a) => !a.startsWith('--'));

interface Entry {
  type: OrgUnitType;
  name: string;
  code: string;
  parentCode?: string;
}

async function main(): Promise<number> {
  if (!file) {
    console.error('Usage: seed-org-tree.ts <tree.json> [--apply]');
    return 2;
  }
  const entries = JSON.parse(readFileSync(file, 'utf8')) as Entry[];
  const valid = new Set(['HOLDING', 'COMPANY', 'PORTFOLIO', 'PROGRAM', 'SITE']);
  for (const e of entries) {
    if (!valid.has(e.type)) {
      console.error(`Invalid type "${e.type}" on code ${e.code}`);
      return 2;
    }
    if (e.type !== 'HOLDING' && !e.parentCode) {
      console.error(`Non-HOLDING node ${e.code} needs a parentCode`);
      return 2;
    }
  }

  // code -> created/found id, built parent-before-child in file order.
  const idByCode = new Map<string, { id: string; path: string }>();
  // Preload existing nodes so re-runs and partial trees resolve.
  const existing = await prisma.orgUnit.findMany({ select: { id: true, code: true, path: true } });
  for (const n of existing) idByCode.set(n.code, { id: n.id, path: n.path });

  let created = 0;
  let found = 0;

  for (const e of entries) {
    const parent = e.parentCode ? idByCode.get(e.parentCode) : undefined;
    if (e.parentCode && !parent) {
      console.error(`Parent ${e.parentCode} of ${e.code} not found (order parents first)`);
      return 2;
    }
    if (idByCode.has(e.code)) {
      found += 1;
      console.log(`  = ${e.code} (${e.type}) exists — untouched`);
      continue;
    }
    created += 1;
    console.log(`  + ${e.code} (${e.type}) ${e.name}${parent ? ` under ${e.parentCode}` : ' [root]'}`);
    if (!apply) {
      // Reserve a placeholder so children in this dry run resolve their parent.
      idByCode.set(e.code, { id: `(dry:${e.code})`, path: '(dry)' });
      continue;
    }
    const node = await prisma.orgUnit.create({
      data: {
        type: e.type,
        name: e.name,
        code: e.code,
        parentId: parent?.id ?? null,
        path: 'pending',
      },
    });
    const path = parent ? `${parent.path}/${node.id}` : `/${node.id}`;
    await prisma.orgUnit.update({ where: { id: node.id }, data: { path } });
    idByCode.set(e.code, { id: node.id, path });
  }

  console.log('');
  console.log(`${created} to create, ${found} already present.`);
  if (!apply) console.log('DRY RUN — re-run with --apply to write.');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('seed-org-tree failed:', err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
