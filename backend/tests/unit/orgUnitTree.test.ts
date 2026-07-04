import { describe, expect, it } from 'vitest';
import type { OrgUnitType } from '@prisma/client';
import { assertValidParentType } from '../../src/lib/orgUnitTree.js';

// v2.5.27: exhaustive placement matrix, now including COMPANY.
// COMPANY: under HOLDING or COMPANY. PORTFOLIO: under HOLDING/COMPANY/PORTFOLIO.
// PROGRAM: under PORTFOLIO/PROGRAM. HOLDING: root only.

const TYPES: OrgUnitType[] = ['HOLDING', 'COMPANY', 'PORTFOLIO', 'PROGRAM'];
const PARENTS: (OrgUnitType | null)[] = [null, 'HOLDING', 'COMPANY', 'PORTFOLIO', 'PROGRAM'];

// Expected validity for every (child, parent) combination.
const VALID = new Set<string>([
  'HOLDING|null',
  'COMPANY|HOLDING',
  'COMPANY|COMPANY',
  'PORTFOLIO|HOLDING',
  'PORTFOLIO|COMPANY',
  'PORTFOLIO|PORTFOLIO',
  'PROGRAM|PORTFOLIO',
  'PROGRAM|PROGRAM',
]);

describe('assertValidParentType — full 4×5 matrix', () => {
  for (const child of TYPES) {
    for (const parent of PARENTS) {
      const key = `${child}|${parent ?? 'null'}`;
      const shouldPass = VALID.has(key);
      it(`${child} under ${parent ?? 'ROOT'} → ${shouldPass ? 'ok' : 'reject'}`, () => {
        if (shouldPass) {
          expect(() => assertValidParentType(child, parent)).not.toThrow();
        } else {
          expect(() => assertValidParentType(child, parent)).toThrow();
        }
      });
    }
  }

  it('COMPANY cannot sit under a delivery structure (PORTFOLIO/PROGRAM)', () => {
    expect(() => assertValidParentType('COMPANY', 'PORTFOLIO')).toThrow();
    expect(() => assertValidParentType('COMPANY', 'PROGRAM')).toThrow();
  });

  it('COMPANY at root is rejected (requires a parent)', () => {
    expect(() => assertValidParentType('COMPANY', null)).toThrow();
  });
});
