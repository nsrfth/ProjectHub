// v1.99 (PMIS R3 — portfolio / program): pure helpers for the OrgUnit tree.
// Path is materialized as "/{id}" at root and "{parent.path}/{id}" below.
// Subtree roll-ups query `path startsWith prefix`.

import type { OrgUnitType } from '@prisma/client';
import { Errors } from './errors.js';

export const HOLDING_ROOT_ID = 'orgunit_holding';

export function orgUnitPath(id: string, parentPath: string | null): string {
  if (!parentPath) return `/${id}`;
  return `${parentPath}/${id}`;
}

/** Prefix for subtree queries — includes the node itself and all descendants. */
export function subtreePathPrefix(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

export function assertValidParentType(
  childType: OrgUnitType,
  parentType: OrgUnitType | null,
): void {
  if (childType === 'HOLDING') {
    if (parentType !== null) {
      throw Errors.badRequest('A HOLDING org unit must be a root node (no parent)');
    }
    return;
  }
  if (parentType === null) {
    throw Errors.badRequest(`${childType} requires a parent org unit`);
  }
  if (childType === 'PORTFOLIO') {
    if (parentType !== 'HOLDING' && parentType !== 'PORTFOLIO') {
      throw Errors.badRequest('A PORTFOLIO must sit under a HOLDING or another PORTFOLIO');
    }
    return;
  }
  // PROGRAM
  if (parentType !== 'PORTFOLIO' && parentType !== 'PROGRAM') {
    throw Errors.badRequest('A PROGRAM must sit under a PORTFOLIO or another PROGRAM');
  }
}

export function assertNoCycle(
  nodeId: string,
  newParentId: string | null,
  newParentPath: string | null,
): void {
  if (!newParentId) return;
  if (newParentId === nodeId) {
    throw Errors.badRequest('An org unit cannot be its own parent');
  }
  if (newParentPath && (newParentPath === `/${nodeId}` || newParentPath.startsWith(`/${nodeId}/`))) {
    throw Errors.badRequest('Cannot move an org unit under one of its descendants');
  }
}
