import { prisma } from '../data/prisma.js';

// v1.88: granular per-project delegate capabilities. A project owner (or admin)
// grants a subset of these to a team member for one project. Enforced field-by-
// field in tasks/subtasksService. FULL is the super-capability — it implies all
// of the granular ones and matches the pre-v1.88 "full-edit delegate".
export type DelegateCapability =
  | 'FULL'
  | 'EDIT_TITLES'
  | 'EDIT_DETAILS'
  | 'EDIT_DATES'
  | 'CHANGE_RESPONSIBLE'
  | 'DELETE_TASKS';

// Granular capabilities in checklist order (FULL excluded — it's the "all" box).
export const GRANULAR_CAPABILITIES: DelegateCapability[] = [
  'EDIT_TITLES',
  'EDIT_DETAILS',
  'EDIT_DATES',
  'CHANGE_RESPONSIBLE',
  'DELETE_TASKS',
];

export const ALL_CAPABILITIES: DelegateCapability[] = ['FULL', ...GRANULAR_CAPABILITIES];

export function isValidCapability(s: string): s is DelegateCapability {
  return (ALL_CAPABILITIES as string[]).includes(s);
}

// Expand a stored list to an effective set: FULL pulls in every granular cap, so
// a FULL delegate behaves exactly like the old all-or-nothing delegate.
export function expandCapabilities(stored: string[]): Set<DelegateCapability> {
  const set = new Set<DelegateCapability>();
  for (const c of stored) if (isValidCapability(c)) set.add(c);
  if (set.has('FULL')) for (const c of GRANULAR_CAPABILITIES) set.add(c);
  return set;
}

// Effective capability set for (project, user). Empty when not a delegate.
export async function getDelegateCapabilities(
  projectId: string,
  userId: string,
): Promise<Set<DelegateCapability>> {
  const row = await prisma.projectEditDelegate.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { capabilities: true },
  });
  return row ? expandCapabilities(row.capabilities) : new Set();
}
