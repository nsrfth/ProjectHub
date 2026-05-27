import { describe, expect, it } from 'vitest';
// The updater sidecar is plain CommonJS (it runs as a standalone Node
// process inside a tiny image), so we require() it directly. The path is
// relative to the repo root because vitest's cwd is backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeAuthCheck } = require('../../../updater/server.js');

// S-1 regression tests (v1.30.2).
//
// The updater sidecar holds the host docker socket — owning it is owning
// the host. Previously the auth check was `if (TOKEN && header !== TOKEN)`,
// which short-circuited to "allow" when TOKEN was empty (any caller on the
// compose network could trigger an upgrade) and used a non-constant-time
// comparison. The fix:
//   1. Refuse to start when the token is unset or < 24 chars.
//   2. Compare the header to the expected token via crypto.timingSafeEqual.

describe('updater auth check (S-1)', () => {
  const GOOD = 'a'.repeat(24); // exactly the minimum

  it('throws at construction when the token is empty', () => {
    expect(() => makeAuthCheck('')).toThrow(/at least 24/);
  });

  it('throws at construction when the token is too short', () => {
    expect(() => makeAuthCheck('short')).toThrow(/at least 24/);
    expect(() => makeAuthCheck('a'.repeat(23))).toThrow(/at least 24/);
  });

  it('throws at construction when the token is undefined / non-string', () => {
    expect(() => makeAuthCheck(undefined)).toThrow();
    expect(() => makeAuthCheck(null)).toThrow();
    expect(() => makeAuthCheck(12345)).toThrow();
  });

  it('returns true for a correct token of any sufficient length', () => {
    const check = makeAuthCheck(GOOD);
    expect(check(GOOD)).toBe(true);
    const longer = 'b'.repeat(64);
    const check2 = makeAuthCheck(longer);
    expect(check2(longer)).toBe(true);
  });

  it('returns false for the wrong token (same length)', () => {
    const check = makeAuthCheck(GOOD);
    expect(check('a'.repeat(23) + 'b')).toBe(false);
  });

  it('returns false for the wrong token (different length, no throw / no leak)', () => {
    const check = makeAuthCheck(GOOD);
    expect(check('a'.repeat(50))).toBe(false);
    expect(check('a'.repeat(5))).toBe(false);
    // Important: the length mismatch must NOT throw, because the underlying
    // crypto.timingSafeEqual otherwise raises on unequal buffers.
    expect(() => check('a'.repeat(50))).not.toThrow();
  });

  it('returns false for missing / empty / non-string headers', () => {
    const check = makeAuthCheck(GOOD);
    expect(check(undefined)).toBe(false);
    expect(check(null)).toBe(false);
    expect(check('')).toBe(false);
    expect(check(12345)).toBe(false);
  });
});
