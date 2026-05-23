import { api } from '@/lib/api';

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

// Returned only by POST. Surfaces the raw token exactly once; the frontend
// shows it in a modal and forgets it.
export interface ApiTokenCreated extends ApiToken {
  rawToken: string;
}

export async function listTokens(): Promise<{ items: ApiToken[] }> {
  return (await api.get<{ items: ApiToken[] }>('/settings/api-tokens')).data;
}

export async function createToken(input: {
  name: string;
  scopes: string[];
  expiresAt?: string | null;
}): Promise<ApiTokenCreated> {
  return (await api.post<ApiTokenCreated>('/settings/api-tokens', input)).data;
}

export async function revokeToken(tokenId: string): Promise<void> {
  await api.delete(`/settings/api-tokens/${tokenId}`);
}
