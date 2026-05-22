import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setAccessToken } from '@/lib/api';
import * as authApi from './api';

interface AuthState {
  user: authApi.AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, name: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
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
        setAccessToken(res.accessToken);
        setUser(res.user);
      },
      signUp: async (email, name, password) => {
        const res = await authApi.register({ email, name, password });
        setAccessToken(res.accessToken);
        setUser(res.user);
      },
      signOut: async () => {
        await authApi.logout().catch(() => {});
        setAccessToken(null);
        setUser(null);
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
