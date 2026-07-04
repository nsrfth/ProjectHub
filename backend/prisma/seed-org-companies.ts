// v2.5.27 (D3): optional COMPANY subsidiary seeding, driven entirely by an
// operator-supplied JSON file — NO subsidiary names are hardcoded. Point
// SEED_ORG_COMPANIES at a file shaped like seed-org-companies.example.json:
//
//   [{ "root": "HOLDING", "name": "Modal Alco Co.", "code": "MDL_CO" },
//    { "root": "HOLDING", "name": "Sub Unit", "code": "SUB1", "parentCode": "MDL_CO" }]
//
// `root` is the HOLDING OrgUnit *code* the company hangs under; `parentCode`
// (optional) nests it under an already-seeded COMPANY with that code instead
// of directly under the HOLDING (sub-subsidiaries per D1). Idempotent: the
// @@unique([parentId, code]) key means re-running never duplicates.

import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

type CompanyEntry = {
  root: string;
  name: string;
  code: string;
  parentCode?: string;
};

function orgUnitPath(id: string, parentPath: string): string {
  return `${parentPath}/${id}`;
}

export async function seedOrgCompanies(prisma: PrismaClient): Promise<void> {
  const path = process.env.SEED_ORG_COMPANIES;
  if (!path) return;

  let entries: CompanyEntry[];
  try {
    entries = JSON.parse(readFileSync(path, 'utf8')) as CompanyEntry[];
  } catch (err) {
    console.warn(`SEED_ORG_COMPANIES: could not read/parse ${path} — skipping.`, err);
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) return;

  let created = 0;
  for (const entry of entries) {
    if (!entry.root || !entry.name || !entry.code) {
      console.warn('SEED_ORG_COMPANIES: entry missing root/name/code — skipping', entry);
      continue;
    }
    const rootCode = entry.root.toUpperCase();
    const code = entry.code.toUpperCase();

    // Resolve the HOLDING root by code.
    const holding = await prisma.orgUnit.findFirst({
      where: { type: 'HOLDING', code: rootCode },
    });
    if (!holding) {
      console.warn(`SEED_ORG_COMPANIES: no HOLDING with code "${rootCode}" — skipping "${entry.name}".`);
      continue;
    }

    // Parent is either the HOLDING itself, or a COMPANY under it (parentCode).
    let parent = holding;
    if (entry.parentCode) {
      const parentCode = entry.parentCode.toUpperCase();
      const parentCompany = await prisma.orgUnit.findFirst({
        where: { type: 'COMPANY', code: parentCode, path: { startsWith: `${holding.path}/` } },
      });
      if (!parentCompany) {
        console.warn(
          `SEED_ORG_COMPANIES: parentCode "${parentCode}" not found under "${rootCode}" — skipping "${entry.name}".`,
        );
        continue;
      }
      parent = parentCompany;
    }

    // Idempotent upsert on the @@unique([parentId, code]) natural key.
    const existing = await prisma.orgUnit.findFirst({
      where: { parentId: parent.id, code },
    });
    if (existing) continue;

    const row = await prisma.orgUnit.create({
      data: { parentId: parent.id, type: 'COMPANY', name: entry.name, code, path: 'pending' },
    });
    await prisma.orgUnit.update({
      where: { id: row.id },
      data: { path: orgUnitPath(row.id, parent.path) },
    });
    created += 1;
  }

  if (created > 0) console.log(`SEED_ORG_COMPANIES: created ${created} COMPANY org unit(s).`);
}
