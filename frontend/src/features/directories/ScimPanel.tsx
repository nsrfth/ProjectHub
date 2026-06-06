import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  generateScimCredential,
  getScimCredential,
  revokeScimCredential,
} from './api';

// Per-directory SCIM credential panel. Rendered inline on the Directories
// list. The raw token surfaces exactly once via a modal that the admin
// dismisses manually — we don't store it anywhere on the frontend either.

interface Props {
  directoryId: string;
  // Absolute base URL the IdP should point at, e.g.
  // https://taskhub.example.com/api/scim/v2. Computed by the parent so the
  // same hostname Caddy is serving on appears in the modal.
  scimBaseUrl: string;
}

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function ScimPanel({ directoryId, scimBaseUrl }: Props): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['scim-cred', directoryId],
    queryFn: () => getScimCredential(directoryId),
  });

  const [name, setName] = useState('Default');
  const [shownToken, setShownToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateMut = useMutation({
    mutationFn: () => generateScimCredential(directoryId, name || 'Default'),
    onSuccess: async (res) => {
      setShownToken(res.rawToken);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['scim-cred', directoryId] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not generate token')),
  });

  const revokeMut = useMutation({
    mutationFn: () => revokeScimCredential(directoryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scim-cred', directoryId] }),
  });

  return (
    <div className="mt-3 border-t pt-3 text-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">SCIM 2.0</p>

      <p className="text-xs text-slate-500 mb-2">
        Base URL:{' '}
        <code className="text-slate-700 bg-slate-100 rounded px-1">{scimBaseUrl}</code>
      </p>

      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}

      {!isLoading && !data && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. Okta)"
            className="border rounded px-2 py-0.5 text-xs"
          />
          <button
            type="button"
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            className="bg-slate-900 text-white rounded px-2 py-0.5 text-xs"
          >
            Generate token
          </button>
        </div>
      )}

      {!isLoading && data && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-600">
            <span className="font-medium">{data.name}</span>
            {data.revokedAt && <span className="ml-1 text-red-600">(revoked)</span>}
            <span className="ml-2 text-slate-400">
              created {new Date(data.createdAt).toLocaleString()}
            </span>
            {data.lastUsedAt && (
              <span className="ml-2 text-slate-400">
                last used {new Date(data.lastUsedAt).toLocaleString()}
              </span>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => generateMut.mutate()}
              disabled={generateMut.isPending}
              className="text-xs underline"
            >
              Rotate
            </button>
            {!data.revokedAt && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Revoke this token? The IdP will lose SCIM access immediately.')) {
                    revokeMut.mutate();
                  }
                }}
                className="text-xs text-red-600 hover:underline"
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}

      {/* One-shot reveal modal — the only place the raw token is ever visible. */}
      {shownToken && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded shadow-lg p-6 max-w-md w-full mx-4">
            <h3 className="font-semibold mb-2">Token generated</h3>
            <p className="text-xs text-slate-600 mb-3">
              Copy it now — this is the only time it will be shown. If you lose it
              you'll need to rotate the credential.
            </p>
            <textarea
              readOnly
              value={shownToken}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full border rounded p-2 text-xs font-mono break-all"
              rows={3}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(shownToken).catch(() => undefined);
                }}
                className="text-xs underline"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setShownToken(null)}
                className="bg-slate-900 text-white rounded px-3 py-1 text-xs"
              >
                I've saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
