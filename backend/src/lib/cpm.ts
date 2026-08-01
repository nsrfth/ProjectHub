// v2.1 (PMIS R5 — scheduling engine): on-demand Critical Path Method (CPM)
// over WBS-leaf tasks + dependency edges. Pure logic + in-memory cache keyed by
// (projectId, scheduleVersion). Cycles → DEPENDENCY_CYCLE 409.
//
// v2.23.0 (PMIS R5 supplement — CPM Schedule Analysis report):
//   * FINISH_TO_START now advances the successor to the day AFTER the
//     predecessor's early finish. The backward pass already applied the
//     matching -1, so the forward pass was asymmetric and produced spurious
//     NEGATIVE float on any network whose stored dates did not already satisfy
//     it. Both directions are now calendar-aware (WORKING edges step over
//     weekends/holidays instead of landing on them).
//   * Total float is measured in the schedule's own unit — working days when a
//     calendar is active, calendar days otherwise. A weekend is not slack.
//   * Adds free float, float classification, the driving predecessor, an
//     ordered critical path, the project window, and an explicit `excluded[]`
//     list so activities dropped from the network are reported rather than
//     silently vanishing.

import type { CalendarMode, DependencyType, LagUnit } from '@prisma/client';
import { AppError } from './errors.js';
import { addCalendarDays, type WorkingDayCalendar } from './workingDays.js';

export interface CpmTaskInput {
  id: string;
  startDate: Date | null;
  dueDate: Date | null;
  isMilestone: boolean;
  isSummary: boolean;
}

export interface CpmEdgeInput {
  id: string;
  taskId: string;
  dependsOnId: string;
  type: DependencyType;
  lag: number;
  lagUnit: LagUnit;
  calendarMode: CalendarMode;
}

export type FloatStatus = 'NEGATIVE' | 'CRITICAL' | 'NEAR_CRITICAL' | 'NORMAL';

/**
 * Why an activity is absent from the network, or why a present activity's float
 * should not be trusted:
 *   NO_DATES      — neither startDate nor dueDate, so it cannot be scheduled.
 *   IS_SUMMARY    — a WBS parent; its dates are a rollup, not work.
 *   ORPHANED_EDGE — the activity IS in the network, but at least one of its
 *                   dependency edges pointed at an excluded activity and was
 *                   dropped. Its float is computed on a severed chain.
 */
export type CpmExclusionReason = 'NO_DATES' | 'IS_SUMMARY' | 'ORPHANED_EDGE';

export interface CpmExclusion {
  taskId: string;
  reason: CpmExclusionReason;
}

export interface CpmTaskResult {
  taskId: string;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloatDays: number;
  isCritical: boolean;
  // v2.23.0 additions — optional-safe for the Gantt overlay, which reads only
  // the fields above.
  freeFloatDays: number;
  floatStatus: FloatStatus;
  /** The predecessor whose bound actually set this activity's early start. */
  drivingPredecessorId: string | null;
  durationDays: number;
}

export interface CpmResult {
  scheduleVersion: number;
  taskCount: number;
  criticalChain: string[];
  tasks: CpmTaskResult[];
  criticalEdgeIds: string[];
  // v2.23.0 additions.
  projectStart: string | null;
  projectFinish: string | null;
  /** The critical set in network (topological) order — milestones inline. */
  criticalPathOrdered: string[];
  criticalPathDurationDays: number;
  excluded: CpmExclusion[];
  nearCriticalDays: number;
}

const cache = new Map<string, CpmResult>();
const FLOAT_EPS = 0.01;

/** The near-critical band baked into the cached artifact. Callers wanting a
 *  different band re-derive with classifyFloat() — float itself is unaffected,
 *  so one cache entry per (project, scheduleVersion) still serves every query. */
export const DEFAULT_NEAR_CRITICAL_DAYS = 3;

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Classifies total float. NEGATIVE (a constraint violation) is kept distinct
 * from CRITICAL (zero float) — collapsing them, as `isCritical` alone does,
 * hides the difference between "this is the path" and "this is already late".
 */
export function classifyFloat(totalFloatDays: number, nearCriticalDays: number): FloatStatus {
  if (totalFloatDays < -FLOAT_EPS) return 'NEGATIVE';
  if (totalFloatDays <= FLOAT_EPS) return 'CRITICAL';
  if (totalFloatDays <= nearCriticalDays + FLOAT_EPS) return 'NEAR_CRITICAL';
  return 'NORMAL';
}

function addLag(
  cal: WorkingDayCalendar | null,
  from: Date,
  lag: number,
  lagUnit: LagUnit,
  mode: CalendarMode,
): Date {
  if (lag === 0) return utcDay(from);
  if (lagUnit === 'HOUR') return utcDay(new Date(from.getTime() + lag * 3_600_000));
  if (mode === 'WORKING' && cal) return utcDay(cal.addWorkingDays(from, lag));
  return utcDay(addCalendarDays(from, lag));
}

/**
 * The one-day gap FINISH_TO_START requires: a successor starts the day after
 * its predecessor finishes. Steps over off-days on WORKING edges so the bound
 * never lands on a weekend or holiday.
 */
function shiftDays(
  cal: WorkingDayCalendar | null,
  from: Date,
  n: number,
  mode: CalendarMode,
): Date {
  if (mode === 'WORKING' && cal) return utcDay(cal.addWorkingDays(from, n));
  return utcDay(addCalendarDays(from, n));
}

function durationDays(
  cal: WorkingDayCalendar | null,
  start: Date,
  end: Date,
  isMilestone: boolean,
): number {
  if (isMilestone) return 0;
  const s = utcDay(start);
  const e = utcDay(end);
  if (cal) return Math.max(1, cal.countWorkingDaysInclusive(s, e));
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
}

/**
 * Elapsed days between two dates in the schedule's own unit. With a calendar
 * active a Fri→Mon gap is 0 days of slack, not 2 — reporting the calendar
 * number would invite a planner to spend float that does not exist.
 */
function spanDays(cal: WorkingDayCalendar | null, from: Date, to: Date): number {
  const a = utcDay(from);
  const b = utcDay(to);
  if (a.getTime() === b.getTime()) return 0;
  if (!cal) return (b.getTime() - a.getTime()) / 86_400_000;
  const sign = b.getTime() > a.getTime() ? 1 : -1;
  const lo = sign > 0 ? a : b;
  const hi = sign > 0 ? b : a;
  // Inclusive count minus one endpoint = the number of working steps between.
  return sign * Math.max(0, cal.countWorkingDaysInclusive(lo, hi) - 1);
}

function finishFromStart(
  cal: WorkingDayCalendar | null,
  start: Date,
  dur: number,
  isMilestone: boolean,
): Date {
  if (isMilestone || dur <= 0) return utcDay(start);
  if (cal) return utcDay(cal.addWorkingDays(start, dur - 1));
  return utcDay(addCalendarDays(start, dur - 1));
}

function startFromFinish(
  cal: WorkingDayCalendar | null,
  finish: Date,
  dur: number,
  isMilestone: boolean,
): Date {
  if (isMilestone || dur <= 0) return utcDay(finish);
  if (cal) return utcDay(cal.addWorkingDays(finish, -(dur - 1)));
  return utcDay(addCalendarDays(finish, -(dur - 1)));
}

function topoSort(ids: string[], edges: CpmEdgeInput[]): string[] {
  const sched = edges.filter((e) => e.type !== 'RELATES_TO');
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const e of sched) {
    if (!indeg.has(e.taskId) || !indeg.has(e.dependsOnId)) continue;
    indeg.set(e.taskId, (indeg.get(e.taskId) ?? 0) + 1);
    adj.get(e.dependsOnId)!.push(e.taskId);
  }
  const q = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  while (q.length) {
    const n = q.shift()!;
    out.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 1) - 1;
      indeg.set(m, d);
      if (d === 0) q.push(m);
    }
  }
  if (out.length !== ids.length) {
    const bad = sched.find((e) => (indeg.get(e.taskId) ?? 0) > 0);
    throw new AppError(409, 'DEPENDENCY_CYCLE', 'Schedule network contains a cycle', {
      edgeId: bad?.id,
      taskId: bad?.taskId,
      dependsOnId: bad?.dependsOnId,
    });
  }
  return out;
}

function emptyResult(scheduleVersion: number, excluded: CpmExclusion[]): CpmResult {
  return {
    scheduleVersion,
    taskCount: 0,
    criticalChain: [],
    tasks: [],
    criticalEdgeIds: [],
    projectStart: null,
    projectFinish: null,
    criticalPathOrdered: [],
    criticalPathDurationDays: 0,
    excluded,
    nearCriticalDays: DEFAULT_NEAR_CRITICAL_DAYS,
  };
}

export function computeCpm(
  tasks: CpmTaskInput[],
  edges: CpmEdgeInput[],
  cal: WorkingDayCalendar | null,
  scheduleVersion: number,
  nearCriticalDays: number = DEFAULT_NEAR_CRITICAL_DAYS,
): CpmResult {
  const excluded: CpmExclusion[] = [];
  const meta = new Map<string, { dur: number; isMilestone: boolean; start: Date | null; due: Date | null }>();
  for (const t of tasks) {
    if (t.isSummary) {
      excluded.push({ taskId: t.id, reason: 'IS_SUMMARY' });
      continue;
    }
    const start = t.startDate ?? t.dueDate;
    const end = t.dueDate ?? t.startDate;
    if (!start || !end) {
      excluded.push({ taskId: t.id, reason: 'NO_DATES' });
      continue;
    }
    meta.set(t.id, {
      dur: durationDays(cal, start, end, t.isMilestone),
      isMilestone: t.isMilestone,
      start: t.startDate,
      due: t.dueDate,
    });
  }
  const ids = [...meta.keys()];
  if (ids.length === 0) return emptyResult(scheduleVersion, excluded);

  const order = topoSort(ids, edges);
  const scheduling = edges.filter((e) => e.type !== 'RELATES_TO');
  const sched = scheduling.filter((e) => meta.has(e.taskId) && meta.has(e.dependsOnId));

  // An edge with exactly one endpoint in the network was severed by an
  // exclusion. Flag the surviving endpoint: its float is real arithmetic over
  // an incomplete chain, and a planner needs to know that before trusting it.
  // (D3 — we report the break rather than inventing a zero-duration bridge.)
  const orphaned = new Set<string>();
  for (const e of scheduling) {
    const hasSucc = meta.has(e.taskId);
    const hasPred = meta.has(e.dependsOnId);
    if (hasSucc === hasPred) continue;
    orphaned.add(hasSucc ? e.taskId : e.dependsOnId);
  }
  for (const taskId of orphaned) excluded.push({ taskId, reason: 'ORPHANED_EDGE' });

  const predecessorsOf = new Map<string, CpmEdgeInput[]>();
  const successorsOf = new Map<string, CpmEdgeInput[]>();
  for (const id of ids) {
    predecessorsOf.set(id, []);
    successorsOf.set(id, []);
  }
  for (const e of sched) {
    predecessorsOf.get(e.taskId)!.push(e);
    successorsOf.get(e.dependsOnId)!.push(e);
  }

  const es = new Map<string, Date>();
  const ef = new Map<string, Date>();
  const driver = new Map<string, string | null>();

  for (const id of order) {
    const { dur, isMilestone, start, due } = meta.get(id)!;
    const storedStart = utcDay(start ?? due!);
    // Track the governing predecessor bound separately from the stored start so
    // a predecessor that lands EXACTLY on the stored start is still reported as
    // the driver — it constrains the activity just as hard as one that pushes it.
    let bestBound: Date | null = null;
    let drivingPred: string | null = null;
    for (const e of predecessorsOf.get(id)!) {
      const predEs = es.get(e.dependsOnId);
      const predEf = ef.get(e.dependsOnId);
      if (!predEs || !predEf) continue;
      let bound: Date;
      switch (e.type) {
        case 'START_TO_START':
          // Start-aligned: no one-day gap.
          bound = addLag(cal, predEs, e.lag, e.lagUnit, e.calendarMode);
          break;
        case 'FINISH_TO_FINISH':
          // Finish-aligned: no one-day gap; back the start out of the finish.
          bound = startFromFinish(
            cal,
            addLag(cal, predEf, e.lag, e.lagUnit, e.calendarMode),
            dur,
            isMilestone,
          );
          break;
        case 'FINISH_TO_START':
        default:
          // The successor starts the day AFTER the predecessor finishes.
          bound = shiftDays(
            cal,
            addLag(cal, predEf, e.lag, e.lagUnit, e.calendarMode),
            1,
            e.calendarMode,
          );
          break;
      }
      if (bestBound === null || bound.getTime() > bestBound.getTime()) {
        bestBound = bound;
        drivingPred = e.dependsOnId;
      }
    }
    const earlyStart =
      bestBound && bestBound.getTime() >= storedStart.getTime() ? bestBound : storedStart;
    if (!bestBound || bestBound.getTime() < storedStart.getTime()) drivingPred = null;
    es.set(id, earlyStart);
    ef.set(id, finishFromStart(cal, earlyStart, dur, isMilestone));
    driver.set(id, drivingPred);
  }

  let projectEnd = ef.get(order[0]!)!;
  let projectBegin = es.get(order[0]!)!;
  for (const id of order) {
    const f = ef.get(id)!;
    const s = es.get(id)!;
    if (f.getTime() > projectEnd.getTime()) projectEnd = f;
    if (s.getTime() < projectBegin.getTime()) projectBegin = s;
  }

  const ls = new Map<string, Date>();
  const lf = new Map<string, Date>();
  for (const id of [...order].reverse()) {
    const { dur, isMilestone } = meta.get(id)!;
    let lateFinish = projectEnd;
    for (const e of successorsOf.get(id)!) {
      const succLs = ls.get(e.taskId);
      const succLf = lf.get(e.taskId);
      if (!succLs || !succLf) continue;
      let bound: Date;
      switch (e.type) {
        case 'START_TO_START':
          bound = finishFromStart(
            cal,
            addLag(cal, succLs, -e.lag, e.lagUnit, e.calendarMode),
            dur,
            isMilestone,
          );
          break;
        case 'FINISH_TO_FINISH':
          bound = addLag(cal, succLf, -e.lag, e.lagUnit, e.calendarMode);
          break;
        case 'FINISH_TO_START':
        default:
          // Mirror of the forward pass: retreat one day, off-day aware.
          bound = shiftDays(
            cal,
            addLag(cal, succLs, -e.lag, e.lagUnit, e.calendarMode),
            -1,
            e.calendarMode,
          );
          break;
      }
      if (bound.getTime() < lateFinish.getTime()) lateFinish = bound;
    }
    lf.set(id, lateFinish);
    ls.set(id, startFromFinish(cal, lateFinish, dur, isMilestone));
  }

  const results: CpmTaskResult[] = [];
  const critical: string[] = [];
  for (const id of ids) {
    const eS = es.get(id)!;
    const lS = ls.get(id)!;
    const eF = ef.get(id)!;
    const float = spanDays(cal, eS, lS);
    const isCritical = float <= FLOAT_EPS;
    if (isCritical) critical.push(id);

    // Free float — how long this activity can slip without moving ANY
    // successor's early start. Terminal activities fall back to total float.
    const succs = successorsOf.get(id)!;
    let freeFloat = float;
    for (const e of succs) {
      const succEs = es.get(e.taskId);
      if (!succEs) continue;
      // In FS terms the successor may legally start the day after this finish;
      // every day beyond that is free slack.
      const slack = spanDays(cal, shiftDays(cal, eF, 1, e.calendarMode), succEs);
      if (slack < freeFloat) freeFloat = slack;
    }
    freeFloat = Math.max(0, freeFloat);

    results.push({
      taskId: id,
      earlyStart: iso(eS),
      earlyFinish: iso(eF),
      lateStart: iso(lS),
      lateFinish: iso(lf.get(id)!),
      totalFloatDays: float,
      isCritical,
      freeFloatDays: freeFloat,
      floatStatus: classifyFloat(float, nearCriticalDays),
      drivingPredecessorId: driver.get(id) ?? null,
      durationDays: meta.get(id)!.dur,
    });
  }

  // The critical set walked in network order, so the path reads start-to-finish
  // rather than in whatever order the rows arrived. Milestones stay inline.
  const criticalSet = new Set(critical);
  const criticalPathOrdered = order.filter((id) => criticalSet.has(id));

  let pathDuration = 0;
  if (criticalPathOrdered.length > 0) {
    let from = es.get(criticalPathOrdered[0]!)!;
    let to = ef.get(criticalPathOrdered[0]!)!;
    for (const id of criticalPathOrdered) {
      const s = es.get(id)!;
      const f = ef.get(id)!;
      if (s.getTime() < from.getTime()) from = s;
      if (f.getTime() > to.getTime()) to = f;
    }
    pathDuration = durationDays(cal, from, to, false);
  }

  return {
    scheduleVersion,
    taskCount: results.length,
    criticalChain: critical,
    tasks: results,
    criticalEdgeIds: sched
      .filter((e) => criticalSet.has(e.taskId) && criticalSet.has(e.dependsOnId))
      .map((e) => e.id),
    projectStart: iso(projectBegin),
    projectFinish: iso(projectEnd),
    criticalPathOrdered,
    criticalPathDurationDays: pathDuration,
    excluded,
    nearCriticalDays,
  };
}

export function getCachedCpm(projectId: string, scheduleVersion: number): CpmResult | undefined {
  return cache.get(`${projectId}:${scheduleVersion}`);
}

export function setCachedCpm(projectId: string, result: CpmResult): void {
  cache.set(`${projectId}:${result.scheduleVersion}`, result);
}

export function invalidateCpmCache(projectId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${projectId}:`)) cache.delete(k);
  }
}
