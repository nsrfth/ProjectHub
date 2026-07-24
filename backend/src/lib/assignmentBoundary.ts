import { prisma } from '../data/prisma.js';
import { Errors } from './errors.js';

// v-next (cross-unit task assignment workflow): classify an intended assignment
// against the org boundary it crosses, so the service can route it to the right
// approver. See docs/ASSIGNMENT_WORKFLOW.md §2 (Slice 2).
//
// Flag-independent BY DESIGN: unlike isWithinAssignmentScope (which short-
// circuits when ACCESS_UNIT_SCOPE is off), this classifier always runs when the
// workflow is enabled, so this plan's ship date does not depend on the
// runbook's ACCESS_UNIT_SCOPE decision (D3). The caller (assertAssignmentAllowed)
// gates ON the workflow flag; the classifier itself just answers the question.
//
// BOUNDARY SEMANTICS (a deliberate refinement of the plan's "requester's and
// target's placement" prose — confirm under D1). A project belongs to a
// DIVISION (Team), never to a department, so the two dimensions have different
// reference points:
//   • Division dimension (→ C): TARGET vs the PROJECT's division. This is what
//     decides whether the assignee needs an access grant at all, so it must be
//     measured against the project, not the requester. A requester sitting in
//     another division (with cross-division project access) assigning someone
//     who IS in the project's division should not trigger a cross-division
//     approval — the target is already home.
//   • Department dimension (A vs B): REQUESTER vs TARGET, within the project's
//     division. "Same department → direct" is inherently relative to the person
//     doing the assigning, because a department is a grouping of people, not a
//     property of the project.

export type AssignmentBoundary =
  | { scenario: 'A' } // same department (or division-general) → direct, no approval
  | { scenario: 'B'; targetGroupId: string } // cross-department → target dept manager
  | { scenario: 'C'; targetTeamId: string }; // cross-division → target division deputy

/**
 * Classify an intended assignment. Never mutates. Throws BAD_REQUEST only when
 * the target belongs to no division at all (unroutable placement — a data
 * problem, distinct from the "unit exists but has no manager" case, which the
 * service handles as D4).
 *
 * Cost: one indexed read for both actors' department memberships (the isUnit +
 * teamId columns are denormalized and trigger-maintained for exactly this),
 * plus at most one more lookup on the cross-division branch. It does not add a
 * round trip ahead of isWithinAssignmentScope on the common same-department (A)
 * path — that path returns after the single read.
 */
export async function classifyAssignmentBoundary(opts: {
  projectTeamId: string; // the project's home division (Project.teamId / Task.teamId)
  requesterUserId: string;
  targetUserId: string;
}): Promise<AssignmentBoundary> {
  const { projectTeamId, requesterUserId, targetUserId } = opts;

  // Both actors' UNIT (department) membership within the project's division, in
  // one read (mirrors filterCandidatesToAssignerScope).
  const unitRows = await prisma.userGroupMember.findMany({
    where: {
      teamId: projectTeamId,
      isUnit: true,
      status: 'ACCEPTED',
      userId: { in: [requesterUserId, targetUserId] },
    },
    select: { userId: true, groupId: true },
  });
  const requesterUnit = unitRows.find((r) => r.userId === requesterUserId)?.groupId ?? null;
  const targetUnit = unitRows.find((r) => r.userId === targetUserId)?.groupId ?? null;

  if (targetUnit) {
    // Target is in a department of the project's division.
    // Same department as the requester → no boundary crossed → direct (A).
    if (requesterUnit && requesterUnit === targetUnit) return { scenario: 'A' };
    // Different department, or the requester is an outsider assigning inward →
    // the TARGET department's manager decides (B).
    return { scenario: 'B', targetGroupId: targetUnit };
  }

  // Target has no department in the project's division. Are they a division-
  // level member of it at all?
  const teamMember = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: targetUserId, teamId: projectTeamId } },
    select: { userId: true },
  });
  if (teamMember) {
    // Division-general staff inside the project's OWN division. POLICY DEFAULT
    // (confirm — D1): directly assignable (A). They already hold division-wide
    // project access (team membership → eligible, no grant needed) and have no
    // department manager, so there is no cross-department boundary to approve.
    // Stricter alternative: route these to the division deputy.
    return { scenario: 'A' };
  }

  // Target is outside the project's division entirely → cross-division (C).
  // The approver is the deputy of the target's HOME division. Home = the
  // division of their (single, one-per-person-enforced) department; failing
  // that, any division they belong to.
  const homeUnit = await prisma.userGroupMember.findFirst({
    where: { userId: targetUserId, isUnit: true, status: 'ACCEPTED' },
    select: { teamId: true },
  });
  let homeTeamId = homeUnit?.teamId ?? null;
  if (!homeTeamId) {
    const anyMembership = await prisma.teamMembership.findFirst({
      where: { userId: targetUserId },
      select: { teamId: true },
    });
    homeTeamId = anyMembership?.teamId ?? null;
  }
  if (!homeTeamId) {
    throw Errors.badRequest("Cannot resolve the assignee's division — they belong to no division");
  }
  return { scenario: 'C', targetTeamId: homeTeamId };
}
