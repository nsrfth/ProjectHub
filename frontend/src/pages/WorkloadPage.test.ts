import { describe, expect, it } from 'vitest';
import { isOverAllocated } from '@/pages/WorkloadPage';
import type { WorkloadDetailRow } from '@/features/reports/api';

const row = (total: number, weightedTotal: number): WorkloadDetailRow => ({
  userId: 'u1',
  name: 'Alice',
  openByStatus: { TODO: total, IN_PROGRESS: 0, REVIEW: 0, PENDING_APPROVAL: 0 },
  byDueBucket: { overdue: 0, this_week: total, next_week: 0, later: 0, no_due: 0 },
  total,
  weightedTotal,
});

describe('isOverAllocated', () => {
  it('highlights above threshold, not at or below', () => {
    expect(isOverAllocated(row(6, 10), 5, false)).toBe(true);
    expect(isOverAllocated(row(5, 10), 5, false)).toBe(false);
    expect(isOverAllocated(row(4, 10), 5, false)).toBe(false);
  });

  it('uses weighted total when weighted mode is on', () => {
    expect(isOverAllocated(row(2, 8), 5, true)).toBe(true);
    expect(isOverAllocated(row(10, 3), 5, true)).toBe(false);
  });

  it('threshold zero disables highlighting', () => {
    expect(isOverAllocated(row(100, 100), 0, false)).toBe(false);
  });
});
