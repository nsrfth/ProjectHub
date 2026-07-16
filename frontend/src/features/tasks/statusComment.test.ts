import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import fa from '../../i18n/fa.json';
import { STATUS_COMMENT_I18N_KEYS, statusCommentRequirement } from './statusComment';

describe('statusCommentRequirement', () => {
  it('requires a comment entering ON_HOLD from any other status', () => {
    expect(statusCommentRequirement('TODO', 'ON_HOLD')).toBe('ON_HOLD');
    expect(statusCommentRequirement('IN_PROGRESS', 'ON_HOLD')).toBe('ON_HOLD');
    expect(statusCommentRequirement('REVIEW', 'ON_HOLD')).toBe('ON_HOLD');
  });

  it('requires a comment entering DONE from any other status', () => {
    expect(statusCommentRequirement('TODO', 'DONE')).toBe('DONE');
    expect(statusCommentRequirement('ON_HOLD', 'DONE')).toBe('DONE');
    expect(statusCommentRequirement('PENDING_APPROVAL', 'DONE')).toBe('DONE');
  });

  it('never requires a comment for other transitions or no-ops', () => {
    expect(statusCommentRequirement('ON_HOLD', 'IN_PROGRESS')).toBeNull(); // exits are free
    expect(statusCommentRequirement('TODO', 'IN_PROGRESS')).toBeNull();
    expect(statusCommentRequirement('DONE', 'TODO')).toBeNull(); // reopen is free
    expect(statusCommentRequirement('ON_HOLD', 'ON_HOLD')).toBeNull();
    expect(statusCommentRequirement('DONE', 'DONE')).toBeNull();
  });
});

describe('status-comment i18n keys', () => {
  it('exist in both catalogs', () => {
    for (const key of STATUS_COMMENT_I18N_KEYS) {
      expect((en as Record<string, string>)[key], `en.json missing ${key}`).toBeTruthy();
      expect((fa as Record<string, string>)[key], `fa.json missing ${key}`).toBeTruthy();
    }
  });
});
