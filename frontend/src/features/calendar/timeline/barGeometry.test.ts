import { describe, expect, it } from 'vitest';
import { barGeometry } from './utils';

// Regression: bars whose span reached outside the visible axis got a negative
// `left` and painted over the sidebar task names — the timeline showed rows
// with a bar and no label. Geometry is now clamped to [0, chartWidth].

const DAY = 86_400_000;
const AXIS = Date.UTC(2026, 7, 1); // 2026-08-01
const DAY_PX = 28;
const CHART_W = 56 * DAY_PX; // week zoom: 56 days

function geom(startDay: number, endDay: number) {
  return barGeometry({
    axisStartMs: AXIS,
    startMs: AXIS + startDay * DAY,
    endMs: AXIS + endDay * DAY,
    dayPx: DAY_PX,
    chartWidth: CHART_W,
  });
}

describe('barGeometry', () => {
  it('places a fully visible bar at its day offset with a 2px gutter', () => {
    const g = geom(2, 4)!;
    expect(g).not.toBeNull();
    expect(g.x).toBe(2 * DAY_PX + 2);
    expect(g.w).toBe(3 * DAY_PX - 4);
    expect(g.clippedStart).toBe(false);
    expect(g.clippedEnd).toBe(false);
  });

  it('never returns a negative left for a bar starting before the window', () => {
    const g = geom(-10, 3)!;
    expect(g.x).toBe(0);
    expect(g.fullX).toBeLessThan(0);
    expect(g.clippedStart).toBe(true);
    // Right edge is untouched: it still ends at the close of day 3.
    expect(g.x + g.w).toBe(4 * DAY_PX - 2);
  });

  it('never extends past the axis for a bar ending after the window', () => {
    const g = geom(50, 400)!;
    expect(g.x).toBe(50 * DAY_PX + 2);
    expect(g.x + g.w).toBe(CHART_W);
    expect(g.clippedEnd).toBe(true);
  });

  it('clamps both edges for a bar spanning the whole window', () => {
    const g = geom(-100, 500)!;
    expect(g.x).toBe(0);
    expect(g.w).toBe(CHART_W);
    expect(g.clippedStart).toBe(true);
    expect(g.clippedEnd).toBe(true);
  });

  it('keeps the unclamped span so a progress overlay stays true to scale', () => {
    const g = geom(-10, 3)!;
    expect(g.fullW).toBe(14 * DAY_PX - 4);
    expect(g.fullX + g.fullW).toBe(g.x + g.w);
  });

  it('drops a bar that lies entirely outside the axis', () => {
    expect(geom(-40, -20)).toBeNull();
    expect(geom(80, 90)).toBeNull();
  });

  it('gives a same-day bar a visible width', () => {
    const g = geom(5, 5)!;
    expect(g.w).toBe(DAY_PX - 4);
  });
});
