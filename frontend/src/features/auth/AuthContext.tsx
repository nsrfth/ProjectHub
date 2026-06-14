import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setAccessToken } from '@/lib/api';
import { adoptServerCalendar } from '@/lib/calendar';
import { adoptServerTheme } from '@/lib/theme';
import { adoptServerLanguage } from '@/lib/i18n';
import { adoptServerDateTimePrefs } from '@/lib/datetime';
import * as authApi from './api';

// v1.13: shared one-liner — adopt every per-user UI preference the
// /auth response carries. Called from refresh / signIn / signInWith2fa
// so the user's prefs travel across devices.
function adoptUserPrefs(u: authApi.AuthUser): void {
  adoptServerCalendar(u.calendarPreference);
  adoptServerTheme(u.themePreference);
  adoptServerLanguage(u.languagePreference);
  adoptServerDateTimePrefs({
    timeZone: u.timeZone,
    timeFormat: u.timeFormat,
    dualCalendar: u.dualCalendar,
  });
}

interface AuthState {
  user: authApi.AuthUser | null;
  loading: boolean;
  // Returns 'ok' if signed in, or 'pending2fa' with a pendingToken the
  // caller hands to signInWith2fa. Pending state isn't stored in the
  // context — the LoginPage owns it for the brief two-step window.
  signIn: (email: string, password: string) => Promise<
    | { kind: 'ok' }
    | { kind: 'pending2fa'; pendingToken: string }
  >;
  signInWith2fa: (pendingToken: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  // Used by Settings → Security after a successful 2FA enrol/disable so the
  // ambient user.totpEnabled flips immediately without a refresh round-trip.
  patchUser: (patch: Partial<authApi.AuthUser>) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<authApi.AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount, try to restore session via the refresh cookie. If it fails the
  // user is just treated as logged out — no error UI.
  useEffect(() => {
    let cancelled = false;
    authApi
      .refresh()
      .then((res) => {
        if (cancelled) return;
        setAccessToken(res.accessToken);
        setUser(res.user);
        // v1.10: sync the per-user calendar pref into localStorage so the
        // formatters / picker pick it up immediately. Subsequent components
        // mounting will see the right calendar.
        adoptUserPrefs(res.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn: async (email, password) => {
        const res = await authApi.login({ email, password });
        if (authApi.isPending2fa(res)) {
          return { kind: 'pending2fa', pendingToken: res.pendingToken };
        }
        setAccessToken(res.accessToken);
        setUser(res.user);
        adoptUserPrefs(res.user);
        return { kind: 'ok' };
      },
      signInWith2fa: async (pendingToken, code) => {
        const res = await authApi.loginTwoFactor({ pendingToken, code });
        setAccessToken(res.accessToken);
        setUser(res.user);
        adoptUserPrefs(res.user);
      },
      signOut: async () => {
        await authApi.logout().catch(() => {});
        setAccessToken(null);
        setUser(null);
      },
      patchUser: (patch) => {
        setUser((prev) => (prev ? { ...prev, ...patch } : prev));
      },
    }),
    [user, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
