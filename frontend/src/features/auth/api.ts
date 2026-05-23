import { api } from '@/lib/api';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  globalRole: 'ADMIN' | 'MEMBER';
  // Phase 2A: non-null when the account is owned by a Directory (LDAP/SCIM).
  // Frontend uses this to hide "change password" + similar local-only actions.
  directoryId: string | null;
  externalId: string | null;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

export async function register(input: { email: string; name: string; password: string }): Promise<AuthResponse> {
  return (await api.post<AuthResponse>('/auth/register', input)).data;
}

export async function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return (await api.post<AuthResponse>('/auth/login', input)).data;
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
}

export async function refresh(): Promise<AuthResponse> {
  return (await api.post<AuthResponse>('/auth/refresh')).data;
}
