import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { fetchAudit, type AuditEntry, type AuditFilters } from '@/features/audit/api';
import { formatShamsiTimestamp } from '@/lib/shamsi';

// Settings → Audit. Paginated, filterable view of the Activity log.
// Authz: backend lets ADMIN see everything and MANAGER see their teams;
// MEMBERs see a "no access" banner instead of a table (and shouldn't have
// reached this route per the layout's role gate anyway, but render-side
// belt-and-suspenders prevents a flash if the role changes mid-session).

export default function AuditPage(): JSX.Element {
  const { user } = useAuth();
  const { teams } = useTeams();
  const isAdmin = user?.globalRole === 'ADMIN';

  const [action, setAction] = useState('');
  const [teamId, setTeamId] = useState<string>(''); // admin-only filter
  const [actorId, setActorId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const filters: AuditFilters = useMemo(
    () => ({
      action: action || undefined,
      teamId: teamId || undefined,
      actorId: actorId || undefined,
      since: since ? new Date(since).toISOString() : undefined,
      until: until ? new Date(until).toISOString() : undefined,
    }),
    [action, teamId, actorId, since, until],
  );

  const { data, fetchNextPage, hasNextPage, isFetching, isError, error } = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchAudit({ ...filters, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const flat = useMemo(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  );

  return (
    <section>
      <header className="mb-4">
        <h2 className="text-lg font-semibold mb-1">Audit log</h2>
        <p className="text-sm text-slate-500">
          {isAdmin
            ? 'Every Activity entry across the instance.'
            : 'Activity in teams you manage.'}
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="action contains…"
          className="border rounded px-2 py-1 text-sm"
        />
        {isAdmin && (
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <input
          value={actorId}
          onChange={(e) => setActorId(e.target.value)}
          placeholder="actor id"
          className="border rounded px-2 py-1 text-sm font-mono"
        />
        <input
          type="datetime-local"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />
        <input
          type="datetime-local"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />
      </div>

      {isError && (
        <p className="text-sm text-red-600">
          {(error as { message?: string })?.message ?? 'Could not load audit log.'}
        </p>
      )}

      {!isError && flat.length === 0 && !isFetching && (
        <p className="text-sm text-slate-500 italic">No entries match these filters.</p>
      )}

      {flat.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500 uppercase">
              <tr className="border-b">
                <th className="py-2 pr-4">When</th>
                <th className="py-2 pr-4">Actor</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Target</th>
                {isAdmin && <th className="py-2 pr-4">Team</th>}
              </tr>
            </thead>
            <tbody>
              {flat.map((a) => <Row key={a.id} entry={a} isAdmin={isAdmin} />)}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        {hasNextPage && (
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetching}
            className="text-sm underline"
          >
            {isFetching ? 'Loading…' : 'Load more'}
          </button>
        )}
        <span className="text-xs text-slate-400">{flat.length} entr{flat.length === 1 ? 'y' : 'ies'} shown</span>
      </div>
    </section>
  );
}

function Row({ entry, isAdmin }: { entry: AuditEntry; isAdmin: boolean }): JSX.Element {
  // Render arbitrary action types — Phase 3A's table doesn't hard-code the
  // task-only event vocabulary so future emitters (directory.created,
  // user.provisioned, auth.2fa_enabled, token.created, webhook.*) appear
  // without code changes.
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="py-2 pr-4 whitespace-nowrap text-slate-500" dir="rtl">
        {formatShamsiTimestamp(entry.createdAt)}
      </td>
      <td className="py-2 pr-4">
        {entry.actorName ?? <span className="italic text-slate-400">(deleted user)</span>}
      </td>
      <td className="py-2 pr-4 font-mono text-xs">{entry.action}</td>
      <td className="py-2 pr-4 text-slate-600 max-w-xs truncate">
        {entry.taskTitle ?? <span className="italic text-slate-400">—</span>}
      </td>
      {isAdmin && (
        <td className="py-2 pr-4 text-slate-500">
          {entry.teamName ?? <span className="italic text-slate-400">—</span>}
        </td>
      )}
    </tr>
  );
}
