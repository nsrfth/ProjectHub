import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

// Single shared HTTP client. Holds the access token in memory only — refresh
// tokens live in an httpOnly cookie the JS never touches.
let accessToken: string | null = null;
type TokenListener = (t: string | null) => void;
const listeners = new Set<TokenListener>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  listeners.forEach((cb) => cb(token));
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function onTokenChange(cb: TokenListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const api: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  withCredentials: true, // send refresh cookie on /api/auth requests
});

api.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
  if (accessToken) {
    cfg.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return cfg;
});

// Refresh-on-401 with single-flight guard so concurrent failed requests trigger
// at most one refresh.
let refreshing: Promise<string | null> | null = null;
async function tryRefresh(): Promise<string | null> {
  if (!refreshing) {
    refreshing = api
      .post('/auth/refresh')
      .then((r) => {
        const t = r.data?.accessToken ?? null;
        setAccessToken(t);
        return t as string | null;
      })
      .catch(() => {
        setAccessToken(null);
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError) => {
    const cfg = err.config as (InternalAxiosRequestConfig & { __retried?: boolean }) | undefined;
    if (err.response?.status === 401 && cfg && !cfg.__retried && !cfg.url?.includes('/auth/')) {
      cfg.__retried = true;
      const t = await tryRefresh();
      if (t) {
        cfg.headers.set('Authorization', `Bearer ${t}`);
        return api.request(cfg);
      }
    }
    return Promise.reject(err);
  },
);
