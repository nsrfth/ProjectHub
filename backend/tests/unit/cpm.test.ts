import { describe, expect, it } from 'vitest';
import type { CalendarMode, DependencyType, LagUnit } from '@prisma/client';
import { computeCpm, classifyFloat, type CpmEdgeInput, type CpmTaskInput } from '../../src/lib/cpm.js';
import { WorkingDayCalendar } from '../../src/lib/workingDays.js';
import { AppError } from '../../src/lib/errors.js';

// v2.23.0 (PMIS R5 supplement): characterization + correctness tests for the CPM
// engine. Written against CORRECT CPM semantics, not against the v2.22.1
// behaviour — the `// PRE-FIX` comments record what the engine returned before
// the FINISH_TO_START and exclusion-reporting fixes so the delta is auditable.
//
// Calendar convention throughout: January 2026. Jan 1 is a Thursday, so
// Jan 5 = Mon, Jan 9 = Fri, Jan 10/11 = Sat/Sun, Jan 12 = Mon.

const d = (day: number): Date => new Date(Date.UTC(2026, 0, day));
const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

function task(
  id: string,
  start: number | null,
  due: number | null,
  opts: { isMilestone?: boolean; isSummary?: boolean } = {},
): CpmTaskInput {
  return {
    id,
    startDate: start === null ? null : d(start),
    dueDate: due === null ? null : d(due),
    isMilestone: opts.isMilestone ?? false,
    isSummary: opts.isSummary ?? false,
  };
}

function edge(
  id: string,
  taskId: string,
  dependsOnId: string,
  opts: {
    type?: DependencyType;
    lag?: number;
    lagUnit?: LagUnit;
    calendarMode?: CalendarMode;
  } = {},
): CpmEdgeInput {
  return {
    id,
    taskId,
    dependsOnId,
    type: (opts.type ?? 'FINISH_TO_START') as DependencyType,
    lag: opts.lag ?? 0,
    lagUnit: (opts.lagUnit ?? 'DAY') as LagUnit,
    calendarMode: (opts.calendarMode ?? 'CALENDAR') as CalendarMode,
  };
}

/** Flattens a result into `{ id: 'ES..EF | LS..LF | TF | FF' }` for readable diffs. */
function rowsById(result: ReturnType<typeof computeCpm>) {
  const out: Record<string, {
    es: string | null; ef: string | null; ls: string | null; lf: string | null;
    tf: number; ff: number; critical: boolean; driver: string | null;
  }> = {};
  for (const t of result.tasks) {
    out[t.taskId] = {
      es: day(t.earlyStart),
      ef: day(t.earlyFinish),
      ls: day(t.lateStart),
      lf: day(t.lateFinish),
      tf: t.totalFloatDays,
      ff: t.freeFloatDays,
      critical: t.isCritical,
      driver: t.drivingPredecessorId,
    };
  }
  return out;
}

describe('computeCpm — FINISH_TO_START semantics', () => {
  it('leaves a slack FS chain alone and reports the gap as float', () => {
    // A finishes Jan 9; B is stored starting Jan 12 — a 2-day gap the network
    // permits, so the stored dates win and A carries 2 days of float.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 12, 14)],
      [edge('e1', 'B', 'A')],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.A).toMatchObject({ es: '2026-01-05', ef: '2026-01-09', ls: '2026-01-07', lf: '2026-01-11', tf: 2, ff: 2, critical: false });
    expect(rows.B).toMatchObject({ es: '2026-01-12', ef: '2026-01-14', ls: '2026-01-12', lf: '2026-01-14', tf: 0, ff: 0, critical: true });
    // Stored date drove B's start, not the predecessor.
    expect(rows.B.driver).toBeNull();
  });

  it('starts the successor the day AFTER the predecessor finishes when the network drives', () => {
    // §3.1 — B is stored Jan 6..Jan 8, which violates the FS edge from A
    // (Jan 5..Jan 9). The network must push B to Jan 10, not Jan 9.
    //
    // PRE-FIX (v2.22.1): B ES 2026-01-09 (== A's EF — a one-day overlap FS
    // forbids) and, because the backward pass already applied the correct -1,
    // A came back with TF -1 for no schedule reason.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 6, 8)],
      [edge('e1', 'B', 'A')],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.A).toMatchObject({ es: '2026-01-05', ef: '2026-01-09', ls: '2026-01-05', lf: '2026-01-09', tf: 0, critical: true });
    expect(rows.B).toMatchObject({ es: '2026-01-10', ef: '2026-01-12', ls: '2026-01-10', lf: '2026-01-12', tf: 0, critical: true });
    expect(rows.B.driver).toBe('A');
    // The whole point: no negative float on a network nobody violated.
    expect(r.tasks.every((t) => t.totalFloatDays >= 0)).toBe(true);
  });

  it('applies FS lag on top of the one-day gap', () => {
    // ES_B = EF_A + 1 (the FS gap) + 2 (lag) = Jan 12.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 6, 8)],
      [edge('e1', 'B', 'A', { lag: 2 })],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.B).toMatchObject({ es: '2026-01-12', ef: '2026-01-14', tf: 0 });
    expect(rows.A).toMatchObject({ ef: '2026-01-09', lf: '2026-01-09', tf: 0 });
  });

  it('is symmetric — the backward pass undoes exactly what the forward pass applied', () => {
    // A 5d -> B 3d -> C 2d, all FS lag 0, all network-driven. Every activity is
    // on the single path, so every total float must be exactly 0.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 1, 2), task('C', 1, 2)],
      [edge('e1', 'B', 'A'), edge('e2', 'C', 'B')],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.A).toMatchObject({ es: '2026-01-05', ef: '2026-01-09' });
    expect(rows.B).toMatchObject({ es: '2026-01-10', ef: '2026-01-11' });
    expect(rows.C).toMatchObject({ es: '2026-01-12', ef: '2026-01-13' });
    expect([rows.A.tf, rows.B.tf, rows.C.tf]).toEqual([0, 0, 0]);
    expect([rows.A.lf, rows.B.lf, rows.C.lf]).toEqual(['2026-01-09', '2026-01-11', '2026-01-13']);
  });
});

describe('computeCpm — other dependency types', () => {
  it('START_TO_START aligns starts with no one-day gap', () => {
    const r = computeCpm(
      [task('A', 5, 9), task('B', 5, 7)],
      [edge('e1', 'B', 'A', { type: 'START_TO_START', lag: 2 })],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.B).toMatchObject({ es: '2026-01-07', ef: '2026-01-09', tf: 0 });
    expect(rows.A).toMatchObject({ es: '2026-01-05', ls: '2026-01-05', tf: 0 });
  });

  it('FINISH_TO_FINISH aligns finishes with no one-day gap', () => {
    const r = computeCpm(
      [task('A', 5, 9), task('B', 5, 7)],
      [edge('e1', 'B', 'A', { type: 'FINISH_TO_FINISH', lag: 1 })],
      null,
      1,
    );
    const rows = rowsById(r);
    // EF_B >= EF_A + 1 = Jan 10; B is 3d so ES_B = Jan 8.
    expect(rows.B).toMatchObject({ es: '2026-01-08', ef: '2026-01-10', tf: 0 });
    expect(rows.A).toMatchObject({ ef: '2026-01-09', lf: '2026-01-09', tf: 0 });
  });

  it('RELATES_TO edges never constrain the schedule', () => {
    const r = computeCpm(
      [task('A', 5, 9), task('B', 6, 8)],
      [edge('e1', 'B', 'A', { type: 'RELATES_TO' })],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.B.es).toBe('2026-01-06');
    expect(rows.B.driver).toBeNull();
  });

  it('treats an HOUR lag as a wall-clock offset on top of the FS gap', () => {
    // 24h lag = one day, plus the FS one-day gap: ES_B = Jan 9 + 1 + 1 = Jan 11.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 6, 7)],
      [edge('e1', 'B', 'A', { lag: 24, lagUnit: 'HOUR' })],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.B).toMatchObject({ es: '2026-01-11', ef: '2026-01-12', tf: 0 });
    // Symmetry holds through the hour path too.
    expect(rows.A).toMatchObject({ lf: '2026-01-09', tf: 0 });
  });
});

describe('computeCpm — working-day calendar', () => {
  const cal = new WorkingDayCalendar([0, 6], []); // Sun + Sat off, no holidays

  it('steps the FS gap over a weekend in both directions', () => {
    // A finishes Fri Jan 9. The successor starts the next WORKING day (Mon
    // Jan 12), and the backward pass must retreat to Fri Jan 9 — not Sun Jan 11.
    //
    // PRE-FIX (v2.22.1): the backward pass used addCalendarDays(-1)
    // unconditionally, landing A's late finish on Sunday Jan 11.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 6, 8)],
      [edge('e1', 'B', 'A', { calendarMode: 'WORKING' })],
      cal,
      1,
    );
    const rows = rowsById(r);
    expect(rows.B).toMatchObject({ es: '2026-01-12', ef: '2026-01-14' });
    expect(rows.A.lf).toBe('2026-01-09');
    expect(cal.isOffDay(new Date(`${rows.A.lf}T00:00:00.000Z`))).toBe(false);
    expect(rows.A.tf).toBe(0);
  });

  it('counts float in working days, not calendar days', () => {
    // A finishes Fri Jan 9; B is stored Mon Jan 12. The calendar gap is 2 days
    // (Sat + Sun) but there are ZERO working days of slack — a planner who
    // reads "2 days float" here and spends them will slip the project.
    const r = computeCpm(
      [task('A', 5, 9), task('B', 12, 13)],
      [edge('e1', 'B', 'A', { calendarMode: 'WORKING' })],
      cal,
      1,
    );
    const rows = rowsById(r);
    expect(rows.A).toMatchObject({ tf: 0, ff: 0, critical: true });
  });
});

describe('computeCpm — milestones', () => {
  it('treats a milestone as zero-duration and keeps it on the path', () => {
    const r = computeCpm(
      [task('A', 5, 9), task('M', null, 9, { isMilestone: true })],
      [edge('e1', 'M', 'A')],
      null,
      1,
    );
    const rows = rowsById(r);
    expect(rows.M).toMatchObject({ es: '2026-01-10', ef: '2026-01-10', tf: 0, critical: true });
    expect(rows.A).toMatchObject({ lf: '2026-01-09', tf: 0 });
    // Milestones sit inline in the ordered critical path, not in a side list.
    expect(r.criticalPathOrdered).toEqual(['A', 'M']);
  });
});

describe('computeCpm — float, driver and path ordering', () => {
  // S -> {P (10d, driver), Q (2d)} -> E. The long leg drives; Q carries slack.
  const network = (): [CpmTaskInput[], CpmEdgeInput[]] => [
    [task('S', 5, 6), task('P', 7, 16), task('Q', 7, 8), task('E', 17, 18)],
    [
      edge('e1', 'P', 'S'),
      edge('e2', 'Q', 'S'),
      edge('e3', 'E', 'P'),
      edge('e4', 'E', 'Q'),
    ],
  ];

  it('separates the driving leg from the slack leg', () => {
    const [t, e] = network();
    const rows = rowsById(computeCpm(t, e, null, 1));
    expect(rows.S).toMatchObject({ tf: 0, critical: true });
    expect(rows.P).toMatchObject({ tf: 0, critical: true });
    expect(rows.E).toMatchObject({ tf: 0, critical: true });
    expect(rows.Q).toMatchObject({ es: '2026-01-07', ef: '2026-01-08', ls: '2026-01-15', lf: '2026-01-16', tf: 8, critical: false });
  });

  it('reports free float separately from total float', () => {
    const [t, e] = network();
    const rows = rowsById(computeCpm(t, e, null, 1));
    // Q can slip 8 days before delaying E (its only successor) — here FF == TF.
    expect(rows.Q.ff).toBe(8);
    // P is hard against E's early start.
    expect(rows.P.ff).toBe(0);
    // S is hard against the earlier of its two successors.
    expect(rows.S.ff).toBe(0);
    // A terminal activity's free float is its total float.
    expect(rows.E.ff).toBe(rows.E.tf);
  });

  it('names the predecessor that actually drove each early start', () => {
    const [t, e] = network();
    const rows = rowsById(computeCpm(t, e, null, 1));
    expect(rows.E.driver).toBe('P'); // not Q — P is the later bound
    expect(rows.P.driver).toBe('S');
    expect(rows.S.driver).toBeNull();
  });

  it('orders the critical path along the network, not by task order', () => {
    const [t, e] = network();
    // Feed the tasks in deliberately scrambled order.
    const r = computeCpm([t[3], t[1], t[2], t[0]], e, null, 1);
    expect(r.criticalPathOrdered).toEqual(['S', 'P', 'E']);
    expect(r.criticalPathOrdered).not.toContain('Q');
  });

  it('reports the project window and critical path length', () => {
    const [t, e] = network();
    const r = computeCpm(t, e, null, 1);
    expect(day(r.projectStart)).toBe('2026-01-05');
    expect(day(r.projectFinish)).toBe('2026-01-18');
    expect(r.criticalPathDurationDays).toBe(14); // Jan 5..Jan 18 inclusive
  });
});

describe('classifyFloat', () => {
  it('separates a constraint violation from a genuine critical path', () => {
    expect(classifyFloat(-3, 3)).toBe('NEGATIVE');
    expect(classifyFloat(0, 3)).toBe('CRITICAL');
    expect(classifyFloat(2, 3)).toBe('NEAR_CRITICAL');
    expect(classifyFloat(3, 3)).toBe('NEAR_CRITICAL');
    expect(classifyFloat(4, 3)).toBe('NORMAL');
  });

  it('collapses to CRITICAL/NORMAL when the near-critical band is zero', () => {
    expect(classifyFloat(0, 0)).toBe('CRITICAL');
    expect(classifyFloat(1, 0)).toBe('NORMAL');
  });
});

describe('computeCpm — exclusions', () => {
  it('excludes an undated activity and flags the edges it severed', () => {
    // §3.2 — A -> B -> C with B undated. B cannot be scheduled, so the
    // transitive A -> C relationship is NOT part of the network. Per D3 we do
    // not invent a zero-duration bridge; instead both surviving endpoints are
    // flagged so nobody reads A's float as trustworthy.
    //
    // PRE-FIX (v2.22.1): B vanished silently and A came back with TF 15 and
    // no indication that its successor chain had been cut.
    const r = computeCpm(
      [task('A', 5, 6), task('B', null, null), task('C', 20, 21)],
      [edge('e1', 'B', 'A'), edge('e2', 'C', 'B')],
      null,
      1,
    );
    expect(r.tasks.map((t) => t.taskId).sort()).toEqual(['A', 'C']);
    expect(r.excluded).toContainEqual({ taskId: 'B', reason: 'NO_DATES' });
    // A and C both lost a link — their float is computed on a severed network.
    expect(r.excluded).toContainEqual({ taskId: 'A', reason: 'ORPHANED_EDGE' });
    expect(r.excluded).toContainEqual({ taskId: 'C', reason: 'ORPHANED_EDGE' });
  });

  it('excludes summary tasks from the network', () => {
    const r = computeCpm(
      [task('P', 5, 20, { isSummary: true }), task('L', 5, 9)],
      [],
      null,
      1,
    );
    expect(r.tasks.map((t) => t.taskId)).toEqual(['L']);
    expect(r.excluded).toContainEqual({ taskId: 'P', reason: 'IS_SUMMARY' });
  });

  it('reports nothing as excluded on a clean network', () => {
    const r = computeCpm([task('A', 5, 9), task('B', 12, 14)], [edge('e1', 'B', 'A')], null, 1);
    expect(r.excluded).toEqual([]);
  });

  it('returns an empty result when no activity can be scheduled', () => {
    const r = computeCpm([task('A', null, null)], [], null, 1);
    expect(r.taskCount).toBe(0);
    expect(r.tasks).toEqual([]);
    expect(r.criticalPathOrdered).toEqual([]);
    expect(r.projectFinish).toBeNull();
    expect(r.excluded).toContainEqual({ taskId: 'A', reason: 'NO_DATES' });
  });
});

describe('computeCpm — cycles', () => {
  it('rejects a cyclic network with DEPENDENCY_CYCLE', () => {
    try {
      computeCpm(
        [task('A', 5, 6), task('B', 7, 8)],
        [edge('e1', 'B', 'A'), edge('e2', 'A', 'B')],
        null,
        1,
      );
      expect.unreachable('expected a DEPENDENCY_CYCLE');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('DEPENDENCY_CYCLE');
      expect((err as AppError).statusCode).toBe(409);
    }
  });
});
