/**
 * Admin-only notice when the SPA is not on a secure origin (same signal browsers
 * use for PWA installability). `isSecureContext` is true on HTTPS and localhost.
 */
export function shouldShowHttpsPwaWarning(
  isAdmin: boolean,
  isSecureContext: boolean,
): boolean {
  return isAdmin && !isSecureContext;
}
