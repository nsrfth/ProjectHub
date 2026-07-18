import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// v2.5.59: source-level regression for the year-timeline's green progress
// fill and its calendar-aware axis wiring. The suite runs on `environment:
// 'node'` with no jsdom and only collects `*.test.ts`, so a React render test
// would never execute — this mirrors ganttScaleRegression.test.ts, which
// guards ProjectGanttPage the same way.

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(__dirname, '../../pages/ProjectsTimelinePage.tsx'), 'utf8');
const ganttPage = readFileSync(join(__dirname, '../../pages/ProjectGanttPage.tsx'), 'utf8');

describe('projects timeline — progress fill', () => {
  it('draws the progress bar with the success token', () => {
    expect(page).toContain("fill: 'var(--color-success)'");
  });

  it('scales the fill by progressPct and clamps it to the planned bar', () => {
    expect(page).toContain('plannedGeom.width * progressPct) / 100');
    expect(page).toContain('Math.min(plannedGeom.width');
  });

  it('renders nothing at 0% and treats a missing field as 0', () => {
    expect(page).toContain('p.progressPct ?? 0');
    expect(page).toContain('progressPct > 0');
  });

  it('keeps the red late-start gap painted after the green fill', () => {
    // Z-order is source order in SVG: planned → progress → marker → gap.
    // "not started" must stay visible over "in progress". Anchor on the JSX
    // guards, not on the token strings — the file header comment names
    // --color-danger long before either rect is rendered.
    const progressAt = page.indexOf('progressPct > 0 && (');
    const gapAt = page.indexOf('{gapGeom && (');
    expect(progressAt).toBeGreaterThan(-1);
    expect(gapAt).toBeGreaterThan(-1);
    expect(progressAt).toBeLessThan(gapAt);
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
  it('passes the calendar preference into the axis and the period label', () => {
    expect(page).toContain('getCalendar');
    expect(page).toContain("buildGanttAxis('year', anchorMs, weekStartDay, todayMs, null, calendar)");
    expect(page).toContain("formatGanttPeriodLabel('year', anchorMs, weekStartDay, null, calendar)");
  });

  it('keeps calendar in the memo dependency arrays', () => {
    expect(page).toContain('[anchorMs, weekStartDay, todayMs, calendar]');
    expect(page).toContain('[anchorMs, weekStartDay, calendar]');
  });

  it('threads the same calendar through the shared project Gantt axis', () => {
    expect(ganttPage).toContain('getCalendar');
    expect(ganttPage).toContain('fitBounds, calendar)');
  });
});
