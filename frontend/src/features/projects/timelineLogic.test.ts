import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import fa from '../../i18n/fa.json';
import {
  PROJECTS_TIMELINE_I18N_KEYS,
  lateStartGapDays,
  projectsTimelineRows,
  type TimelineProjectInput,
} from './timelineLogic';

const TODAY = Date.UTC(2026, 6, 17); // 2026-07-17

function proj(over: Partial<TimelineProjectInput> & { id: string }): TimelineProjectInput {
  return {
    name: over.id,
    teamId: 't1',
    teamName: 'Team One',
    status: 'ACTIVE',
    startDate: null,
    endDate: null,
    ...over,
  };
}

describe('lateStartGapDays', () => {
  it('1) counts whole days between planned start and today when not started', () => {
    expect(lateStartGapDays('2026-07-07T00:00:00.000Z', false, TODAY)).toBe(10);
    expect(lateStartGapDays('2026-07-16T00:00:00.000Z', false, TODAY)).toBe(1);
  });

  it('2) is 0 once the project has started, however old the plan', () => {
    expect(lateStartGapDays('2026-01-01T00:00:00.000Z', true, TODAY)).toBe(0);
  });

  it('3) is 0 when hasStarted is unknown (older backend omits the field)', () => {
    expect(lateStartGapDays('2026-01-01T00:00:00.000Z', undefined, TODAY)).toBe(0);
  });

  it('4) is 0 for today, future, missing, or unparsable start dates', () => {
    expect(lateStartGapDays('2026-07-17T00:00:00.000Z', false, TODAY)).toBe(0);
    expect(lateStartGapDays('2026-08-01T00:00:00.000Z', false, TODAY)).toBe(0);
    expect(lateStartGapDays(null, false, TODAY)).toBe(0);
    expect(lateStartGapDays(undefined, false, TODAY)).toBe(0);
    expect(lateStartGapDays('not-a-date', false, TODAY)).toBe(0);
  });
});

describe('projectsTimelineRows', () => {
  const rows = [
    proj({ id: 'endOnly', endDate: '2026-03-01T00:00:00.000Z' }),
    proj({ id: 'late', startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' }),
    proj({ id: 'early', startDate: '2026-01-05T00:00:00.000Z' }),
    proj({ id: 'none' }),
    proj({ id: 'otherTeam', teamId: 't2', teamName: 'Team Two', startDate: '2026-01-01T00:00:00.000Z' }),
    proj({ id: 'archived', status: 'ARCHIVED', startDate: '2026-04-01T00:00:00.000Z' }),
  ];

  it('1) splits scheduled (>=1 date) from unscheduled (no dates)', () => {
    const { scheduled, unscheduled } = projectsTimelineRows(rows, { teamId: '', status: '' });
    expect(scheduled.map((p) => p.id)).toContain('endOnly');
    expect(unscheduled.map((p) => p.id)).toEqual(['none']);
  });

  it('2) sorts by startDate ascending with null starts last', () => {
    const { scheduled } = projectsTimelineRows(rows, { teamId: '', status: '' });
    expect(scheduled.map((p) => p.id)).toEqual([
      'otherTeam',
      'early',
      'late',
      'archived',
      'endOnly',
    ]);
  });

  it('3) team filter narrows both lists; empty string means all teams', () => {
    const t2 = projectsTimelineRows(rows, { teamId: 't2', status: '' });
    expect(t2.scheduled.map((p) => p.id)).toEqual(['otherTeam']);
    expect(t2.unscheduled).toEqual([]);
    const all = projectsTimelineRows(rows, { teamId: '', status: '' });
    expect(all.scheduled.length + all.unscheduled.length).toBe(rows.length);
  });

  it('4) status filter matches exactly; empty string means all statuses', () => {
    const active = projectsTimelineRows(rows, { teamId: '', status: 'ACTIVE' });
    expect(active.scheduled.map((p) => p.id)).not.toContain('archived');
    const archived = projectsTimelineRows(rows, { teamId: '', status: 'ARCHIVED' });
    expect(archived.scheduled.map((p) => p.id)).toEqual(['archived']);
  });

  it('5) page i18n keys exist in both en.json and fa.json', () => {
    for (const key of PROJECTS_TIMELINE_I18N_KEYS) {
      expect(en[key as keyof typeof en], `en missing ${key}`).toBeTruthy();
      expect(fa[key as keyof typeof fa], `fa missing ${key}`).toBeTruthy();
    }
  });
});
