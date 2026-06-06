import { describe, expect, it } from 'vitest';
import { isNewer, parseVersion } from '../../src/services/updateCheckService.js';

// Pure semver comparison — exercises the edges that decide whether the
// "update available" badge renders.

describe('parseVersion', () => {
  it('parses bare semver', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('parses with the leading "v"', () => {
    expect(parseVersion('v1.15.0')).toEqual([1, 15, 0]);
  });

  it('parses with a trailing pre-release suffix (ignored for ordering)', () => {
    expect(parseVersion('v1.15.0-rc.1')).toEqual([1, 15, 0]);
  });

  it('returns null for non-semver strings', () => {
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('isNewer', () => {
  it('is true when the latest tag is strictly higher', () => {
    expect(isNewer('v1.16.0', '1.15.0')).toBe(true);
    expect(isNewer('v2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('v1.15.1', 'v1.15.0')).toBe(true);
  });

  it('is false when equal — avoids the spurious "same version available" badge', () => {
    expect(isNewer('v1.15.0', '1.15.0')).toBe(false);
    expect(isNewer('v1.15.0', 'v1.15.0')).toBe(false);
  });

  it('is false when the running version is newer (local build ahead of release)', () => {
    expect(isNewer('v1.14.0', '1.15.0')).toBe(false);
  });

  it('is false when either side is null or unparseable', () => {
    expect(isNewer(null, '1.15.0')).toBe(false);
    expect(isNewer('v1.16.0', 'dev')).toBe(false);
    expect(isNewer('garbage', '1.15.0')).toBe(false);
  });
});
