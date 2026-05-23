import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import {
  createToken,
  listTokens,
  revokeToken,
  type ApiToken,
} from '@/features/apiTokens/api';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  testWebhook,
  updateWebhook,
} from '@/features/webhooks/api';
import { formatShamsiTimestamp } from '@/lib/shamsi';

// Settings → API & Webhooks. Two sections: per-user API tokens (everyone
// can manage their own), and team-scoped webhooks (managers of the
// currently-selected team).

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function ApiWebhooksPage(): JSX.Element {
  const { currentTeam } = useTeams();
  return (
    <section className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold mb-1">API & Webhooks</h2>
        <p className="text-sm text-slate-500">
          Personal API tokens for scripting + team-scoped outbound webhooks.
        </p>
      </header>

      <ApiTokensSection />

      <hr />

      {currentTeam ? (
        <WebhooksSection teamId={currentTeam.id} teamName={currentTeam.name} />
      ) : (
        <p className="text-sm text-slate-500 italic">Select a team to manage its webhooks.</p>
      )}
    </section>
  );
}

// ── API tokens ────────────────────────────────────────────────────────────
function ApiTokensSection(): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['api-tokens'], queryFn: listTokens });

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState('*');
  const [shownToken, setShownToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      createToken({
        name: name || 'CLI',
        scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: async (res) => {
      setShownToken(res.rawToken);
      setName('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not create token')),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  });

  return (
    <div>
      <h3 className="font-medium mb-2">API tokens</h3>
      <p className="text-xs text-slate-500 mb-3">
        Bearer tokens that authenticate scripts + integrations as you. Revoke
        immediately if leaked.
      </p>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          createMut.mutate();
        }}
        className="flex flex-wrap items-end gap-2 mb-3"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
            placeholder="CI bot"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Scopes</span>
          <input
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            className="border rounded px-2 py-1 text-sm font-mono"
            placeholder="* or tasks:read,tasks:write"
          />
        </label>
        <button
          type="submit"
          disabled={createMut.isPending}
          className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium"
        >
          Generate
        </button>
      </form>

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      <ul className="divide-y border rounded">
        {(data?.items ?? []).map((t) => <TokenRow key={t.id} t={t} onRevoke={() => revokeMut.mutate(t.id)} />)}
        {(data?.items ?? []).length === 0 && (
          <li className="text-xs text-slate-500 italic p-3">No tokens yet.</li>
        )}
      </ul>

      {shownToken && (
        <RevealModal
          title="Copy your API token"
          value={shownToken}
          helper="This is the only time it will be shown. Treat it like a password."
          onClose={() => setShownToken(null)}
        />
      )}
    </div>
  );
}

function TokenRow({ t, onRevoke }: { t: ApiToken; onRevoke: () => void }): JSX.Element {
  return (
    <li className="p-2 text-sm flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium truncate">{t.name}</p>
        <p className="text-xs text-slate-500 truncate">
          <code className="bg-slate-100 rounded px-1">{t.prefix}…</code>
          {' · '}
          {t.scopes.join(', ')}
          {t.expiresAt && <> · expires <span dir="rtl">{formatShamsiTimestamp(t.expiresAt)}</span></>}
          {t.lastUsedAt && <> · last used <span dir="rtl">{formatShamsiTimestamp(t.lastUsedAt)}</span></>}
          {t.revokedAt && <span className="ml-1 text-red-600">(revoked)</span>}
        </p>
      </div>
      {!t.revokedAt && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Revoke "${t.name}"? Anything using it will stop working.`)) onRevoke();
          }}
          className="text-xs text-red-600 hover:underline flex-shrink-0"
        >
          Revoke
        </button>
      )}
    </li>
  );
}

// ── Webhooks ──────────────────────────────────────────────────────────────
const KNOWN_EVENTS = ['task.created', 'task.updated', 'task.status_changed', 'task.deleted', 'comment.added'];

function WebhooksSection({ teamId, teamName }: { teamId: string; teamName: string }): JSX.Element {
  const { user } = useAuth();
  const { teams } = useTeams();
  const currentTeamRow = teams.find((t) => t.id === teamId);
  const canManage = user?.globalRole === 'ADMIN' || currentTeamRow?.myRole === 'MANAGER';

  const qc = useQueryClient();
  const { data, isError } = useQuery({
    queryKey: ['webhooks', teamId],
    queryFn: () => listWebhooks(teamId),
    enabled: canManage,
  });

  const [showForm, setShowForm] = useState(false);
  const [shownSecret, setShownSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const createMut = useMutation({
    mutationFn: (input: { name: string; url: string; events: string[] }) => createWebhook(teamId, input),
    onSuccess: async (res) => {
      setShownSecret(res.rawSecret);
      setShowForm(false);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['webhooks', teamId] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not create webhook')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteWebhook(teamId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', teamId] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      updateWebhook(teamId, id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', teamId] }),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => testWebhook(teamId, id),
    onSuccess: (r, id) => setTest((t) => ({ ...t, [id]: { ok: r.ok, msg: r.errorMessage ?? `HTTP ${r.httpStatus ?? '?'}` } })),
    onError: (err, id) => setTest((t) => ({ ...t, [id]: { ok: false, msg: errorMessage(err, 'Test failed') } })),
  });

  if (!canManage) {
    return (
      <div>
        <h3 className="font-medium mb-2">Webhooks</h3>
        <p className="text-sm text-slate-500 italic">
          Webhooks are managed by the team's managers.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <div>
          <h3 className="font-medium">Webhooks for {teamName}</h3>
          <p className="text-xs text-slate-500">
            Outbound HTTP delivery for team events. Each delivery carries an
            <code className="mx-1 bg-slate-100 rounded px-1">X-TaskHub-Signature</code>
            header (HMAC-SHA256 of the body using the signing secret).
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => { setShowForm(true); setError(null); }}
            className="bg-slate-900 text-white rounded px-3 py-1 text-xs font-medium"
          >
            New webhook
          </button>
        )}
      </div>

      {isError && <p className="text-xs text-red-600">Could not load webhooks.</p>}

      {showForm && <WebhookForm onSubmit={(v) => createMut.mutate(v)} onCancel={() => setShowForm(false)} pending={createMut.isPending} />}
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      <ul className="divide-y border rounded mt-3">
        {(data?.items ?? []).map((w) => (
          <li key={w.id} className="p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium truncate">
                  {w.name}{' '}
                  <span className={`text-xs ${w.active ? 'text-emerald-700' : 'text-slate-400'}`}>
                    ({w.active ? 'active' : 'paused'})
                  </span>
                </p>
                <p className="text-xs text-slate-500 truncate">{w.url}</p>
                <p className="text-xs text-slate-500">events: {w.events.join(', ')}</p>
                {test[w.id] && (
                  <p className={`text-xs mt-1 ${test[w.id]!.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                    {test[w.id]!.ok ? '✓ ' : '✗ '}
                    {test[w.id]!.msg}
                  </p>
                )}
              </div>
              <div className="flex gap-2 flex-shrink-0 text-xs">
                <button onClick={() => testMut.mutate(w.id)} disabled={testMut.isPending} className="underline">Test</button>
                <button onClick={() => toggleMut.mutate({ id: w.id, active: !w.active })} className="underline">
                  {w.active ? 'Pause' : 'Resume'}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete webhook "${w.name}"?`)) deleteMut.mutate(w.id);
                  }}
                  className="text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
            </div>
            <DeliveriesPanel teamId={teamId} webhookId={w.id} />
          </li>
        ))}
        {(data?.items ?? []).length === 0 && !showForm && (
          <li className="text-xs text-slate-500 italic p-3">No webhooks yet.</li>
        )}
      </ul>

      {shownSecret && (
        <RevealModal
          title="Copy your signing secret"
          value={shownSecret}
          helper="Your receiver uses this to verify the X-TaskHub-Signature header (HMAC-SHA256 of the body). This is the only time the secret will be shown."
          onClose={() => setShownSecret(null)}
        />
      )}
    </div>
  );
}

function WebhookForm({
  onSubmit,
  onCancel,
  pending,
}: {
  onSubmit: (v: { name: string; url: string; events: string[] }) => void;
  onCancel: () => void;
  pending: boolean;
}): JSX.Element {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<Set<string>>(new Set(['task.created']));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, url, events: [...events] });
      }}
      className="border rounded p-3 space-y-2 bg-slate-50 mt-2"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-slate-600">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="border rounded px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-slate-600">URL</span>
          <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} className="border rounded px-2 py-1" placeholder="https://example.com/hook" />
        </label>
      </div>
      <fieldset>
        <legend className="text-xs text-slate-600 mb-1">Events</legend>
        <div className="flex flex-wrap gap-3 text-xs">
          {KNOWN_EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={events.has(ev)}
                onChange={(e) => {
                  setEvents((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(ev);
                    else next.delete(ev);
                    return next;
                  });
                }}
              />
              <code>{ev}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-2">
        <button type="submit" disabled={pending || !name || !url || events.size === 0} className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50">
          Create
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline">Cancel</button>
      </div>
    </form>
  );
}

function DeliveriesPanel({ teamId, webhookId }: { teamId: string; webhookId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['webhook-deliveries', teamId, webhookId],
    queryFn: () => listDeliveries(teamId, webhookId, 20),
    enabled: open,
  });
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs underline text-slate-600">
        {open ? 'Hide deliveries' : 'Show recent deliveries'}
      </button>
      {open && (
        <ul className="mt-2 text-xs space-y-1">
          {(data?.items ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span className={`inline-block w-16 ${
                d.status === 'DELIVERED' ? 'text-emerald-700'
                : d.status === 'FAILED' ? 'text-red-700'
                : 'text-amber-700'
              }`}>{d.status}</span>
              <span className="font-mono">{d.eventType}</span>
              <span className="text-slate-500">
                attempt {d.attempt}/{d.maxAttempts}
                {d.httpStatus && ` · HTTP ${d.httpStatus}`}
                {d.errorMessage && ` · ${d.errorMessage}`}
              </span>
              <span className="text-slate-400 ml-auto" dir="rtl">{formatShamsiTimestamp(d.createdAt)}</span>
            </li>
          ))}
          {(data?.items ?? []).length === 0 && (
            <li className="text-slate-500 italic">No deliveries yet.</li>
          )}
        </ul>
      )}
    </div>
  );
}

// ── Reveal modal (shared) ─────────────────────────────────────────────────
function RevealModal({
  title,
  value,
  helper,
  onClose,
}: { title: string; value: string; helper: string; onClose: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded shadow-lg p-6 max-w-md w-full mx-4">
        <h3 className="font-semibold mb-2">{title}</h3>
        <p className="text-xs text-slate-600 mb-3">{helper}</p>
        <textarea
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full border rounded p-2 text-xs font-mono break-all"
          rows={3}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(value).catch(() => undefined);
              setCopied(true);
            }}
            className="text-xs underline"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="bg-slate-900 text-white rounded px-3 py-1 text-xs"
          >
            I've saved it
          </button>
        </div>
      </div>
    </div>
  );
}
