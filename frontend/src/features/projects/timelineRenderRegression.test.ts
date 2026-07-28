import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// v2.5.59 → v2.22: this file used to pin the year-timeline's SVG rendering.
// The page was rebuilt on the interactive Gantt (components/ui/gantt.tsx), so
// the assertions were rewritten onto the new implementation — but they guard
// the SAME behaviours, because those are what the SVG version got right:
// a green progress fill clamped to the bar, a red late-start gap that stays
// visible over it, a calendar-aware axis, and progress reported in the
// tooltip. The exact geometry is unit-tested for real in
// components/ui/gantt-geometry.test.ts; this file only guards the wiring.
//
// The suite runs on `environment: 'node'` with no jsdom and collects only
// `*.test.ts`, so a React render test would never execute — hence
// source-level assertions, mirroring ganttScaleRegression.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

/** Comment-free view — several files name a symbol in prose to explain why
 *  they avoid it, which a bare `not.toContain` would flag as a violation. */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const page = read('../../pages/ProjectsTimelinePage.tsx');
const ganttPage = read('../../pages/ProjectGanttPage.tsx');
const gantt = read('../../components/ui/gantt.tsx');
const geometry = read('../../components/ui/gantt-geometry.ts');

describe('projects timeline — progress fill', () => {
  it('draws the progress bar with the success token', () => {
    expect(page).toContain("'var(--color-success)'");
  });

  it('scales the fill by progressPct and clamps it to the planned bar', () => {
    // Percentage of the bar element, which the Gantt has already sized from
    // the column geometry — so the fill cannot drift from its own bar.
    expect(page).toContain('Math.min(progressPct, 100)}%');
  });

  it('renders nothing at 0% and treats a missing field as 0', () => {
    expect(page).toContain('p.progressPct ?? 0');
    expect(page).toContain('progressPct > 0');
  });

  it('keeps the red late-start gap painted after the green fill', () => {
    // Source order is paint order for absolutely-positioned siblings.
    // "not started" must stay visible over "in progress".
    const progressAt = page.indexOf('{progressPct > 0 && (');
    const gapAt = page.indexOf('{gapDays > 0 && (');
    expect(progressAt).toBeGreaterThan(-1);
    expect(gapAt).toBeGreaterThan(-1);
    expect(progressAt).toBeLessThan(gapAt);
  });

  it('derives the late gap from the shared lateStartGapDays helper', () => {
    expect(page).toContain('lateStartGapDays(p.startDate, p.hasStarted, todayMs)');
    expect(page).toContain("'var(--color-danger)'");
  });

  it('reports progress in the tooltip, not as on-bar text', () => {
    expect(page).toContain("t('projects.timeline.progress')");
  });

  it('routes every token through style={{ }}, never an SVG presentation attribute', () => {
    expect(page).not.toMatch(/fill="var\(/);
    expect(page).not.toMatch(/stroke="var\(/);
  });
});

describe('projects timeline — calendar-aware axis', () => {
  it('anchors the timeline on a Jalali year under SHAMSI', () => {
    expect(page).toContain('getCalendar');
    expect(page).toContain('jalaliYearOfUtcMs');
    expect(page).toContain('anchorYear={anchorYear}');
  });

  it('builds Jalali columns from lib/shamsi rather than Gregorian month maths', () => {
    expect(geometry).toContain('jalaliYearMonths');
    expect(geometry).toContain("calendar === 'SHAMSI'");
    // The whole point of the module: no date-fns calendar arithmetic, which
    // is Gregorian-only and local-time based.
    expect(codeOnly(geometry)).not.toMatch(/from 'date-fns'/);
    expect(codeOnly(geometry)).not.toContain('getDaysInMonth');
    expect(codeOnly(geometry)).not.toContain('differenceInMonths');
  });

  it('threads the same calendar through the shared project Gantt axis', () => {
    expect(ganttPage).toContain('getCalendar');
    expect(ganttPage).toContain('fitBounds, calendar)');
  });
});

describe('projects timeline — rescheduling', () => {
  it('persists a dragged bar through updateProject', () => {
    expect(page).toContain('updateProject(project.teamId, project.id');
    expect(page).toContain('onMove={');
  });

  it('re-fetches after a failed save so the bar cannot sit at an unsaved position', () => {
    const onErrorAt = page.indexOf('onError:');
    expect(onErrorAt).toBeGreaterThan(-1);
    expect(page.slice(onErrorAt)).toContain("invalidateQueries({ queryKey: ['projects', 'all'] })");
    expect(page).toContain("t('projects.timeline.saveError')");
  });
});

describe('gantt component — repo conventions', () => {
  it('uses the configurable off-day set, not a hardcoded Sat/Sun weekend', () => {
    expect(geometry).toContain('isOffDay');
    expect(codeOnly(geometry)).not.toContain('[0, 6].includes');
  });

  it('pins the scrolling timeline to LTR so offsets are not mirrored under RTL', () => {
    expect(gantt).toContain('dir="ltr"');
  });

  it('uses this repo’s semantic tokens, not undefined shadcn ones', () => {
    for (const token of [
      'bg-backdrop',
      'text-muted-foreground',
      'bg-card',
      'text-foreground',
      'bg-background',
      'text-destructive',
    ]) {
      expect(codeOnly(gantt), `${token} is not defined in tailwind.config.ts`).not.toContain(
        token,
      );
    }
  });

  it('keeps date-fns away from positioning (it is local-time based)', () => {
    // One sanctioned use: the duration string between two UTC-midnight
    // instants, which is timezone-insensitive.
    expect(gantt).toContain("import { formatDistanceStrict } from 'date-fns'");
    expect(codeOnly(gantt)).not.toContain('differenceInDays');
    expect(codeOnly(gantt)).not.toContain('getDaysInMonth');
  });
});
