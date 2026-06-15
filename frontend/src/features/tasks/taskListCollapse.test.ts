import { describe, expect, it } from 'vitest';
import { toggleExpandedTaskIds } from './taskListCollapse';

describe('toggleExpandedTaskIds', () => {
  it('expands a collapsed task independently', () => {
    expect(toggleExpandedTaskIds(new Set(), 'a')).toEqual(new Set(['a']));
  });

  it('collapses an expanded task without affecting others', () => {
    const next = toggleExpandedTaskIds(new Set(['a', 'b']), 'a');
    expect(next.has('a')).toBe(false);
    expect(next.has('b')).toBe(true);
  });
});
