import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as teamsApi from '@/features/teams/api';
import { useTeams } from '@/features/teams/TeamsContext';
import { formatShamsiTimestampDate } from '@/lib/shamsi';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function TeamsPage(): JSX.Element {
  const { teams, currentTeamId, setCurrentTeamId, refresh } = useTeams();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (input: { name: string; slug: string }) => teamsApi.createTeam(input),
    onSuccess: async (team) => {
      setName('');
      setSlug('');
      setCreateError(null);
      await refresh();
      setCurrentTeamId(team.id);
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create team')),
  });

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    createMut.mutate({ name, slug });
  }

  // Detail panel for whichever team is currently selected.
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['teams', 'detail', currentTeamId],
    queryFn: () => teamsApi.getTeam(currentTeamId!),
    enabled: !!currentTeamId,
  });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<teamsApi.TeamRole>('MEMBER');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const inviteMut = useMutation({
    mutationFn: (input: { email: string; role: teamsApi.TeamRole }) =>
      teamsApi.addMember(currentTeamId!, input),
    onSuccess: async () => {
      setInviteEmail('');
      setInviteError(null);
      await qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] });
    },
    onError: (err) => setInviteError(errorMessage(err, 'Could not add member')),
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) => teamsApi.removeMember(currentTeamId!, userId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] });
    },
  });

  const isManager = detail?.myRole === 'MANAGER';

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Teams</h1>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <aside className="md:col-span-1 bg-white rounded shadow p-4 space-y-4">
          <h2 className="font-medium">Your teams</h2>
          <ul className="space-y-1">
            {teams.length === 0 && (
              <li className="text-sm text-slate-500">No teams yet — create one.</li>
            )}
            {teams.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setCurrentTeamId(t.id)}
                  className={`w-full text-left rounded px-2 py-1 text-sm ${
                    t.id === currentTeamId ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
                  }`}
                >
                  {t.name}
                  <span className="ml-2 text-xs opacity-70">{t.myRole}</span>
                </button>
              </li>
            ))}
          </ul>

          <form onSubmit={onCreate} className="pt-4 border-t space-y-2">
            <h3 className="text-sm font-medium">New team</h3>
            <input
              type="text"
              required
              placeholder="Team name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border-slate-300 px-2 py-1 border text-sm"
            />
            <input
              type="text"
              required
              placeholder="slug-like-this"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              className="w-full rounded border-slate-300 px-2 py-1 border text-sm font-mono"
            />
            {createError && <p className="text-xs text-red-600">{createError}</p>}
            <button
              type="submit"
              disabled={createMut.isPending}
              className="w-full bg-slate-900 text-white rounded py-1 text-sm font-medium disabled:opacity-50"
            >
              {createMut.isPending ? 'Creating…' : 'Create'}
            </button>
          </form>
        </aside>

        <main className="md:col-span-2 bg-white rounded shadow p-4">
          {!currentTeamId && <p className="text-sm text-slate-500">Select or create a team.</p>}
          {currentTeamId && detailLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {detail && (
            <>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium flex items-center gap-2">
                    {detail.color && (
                      <span
                        aria-hidden
                        className="inline-block w-4 h-4 rounded-full border border-slate-200"
                        style={{ background: detail.color }}
                      />
                    )}
                    {detail.name}
                  </h2>
                  <p className="text-xs font-mono text-slate-500">{detail.slug}</p>
                </div>
                {isManager && <TeamColourPicker team={detail} />}
              </div>

              <h3 className="text-sm font-medium mb-2">Members</h3>
              <ul className="space-y-1 mb-4">
                {detail.members.map((m) => (
                  <li
                    key={m.userId}
                    className="flex items-center justify-between text-sm border-b last:border-0 py-1"
                  >
                    <span>
                      <span className="font-medium">{m.name}</span>
                      <span className="text-slate-500 ml-2">{m.email}</span>
                      <span className="text-xs text-slate-400 ml-2" dir="rtl">
                        پیوست {formatShamsiTimestampDate(m.joinedAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs uppercase tracking-wide text-slate-500">
                        {m.role}
                      </span>
                      {isManager && (
                        <button
                          onClick={() => removeMut.mutate(m.userId)}
                          className="text-xs text-red-600 hover:underline disabled:opacity-50"
                          disabled={removeMut.isPending}
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {isManager && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    inviteMut.mutate({ email: inviteEmail, role: inviteRole });
                  }}
                  className="pt-4 border-t space-y-2"
                >
                  <h3 className="text-sm font-medium">Add member</h3>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      required
                      placeholder="user@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      className="flex-1 rounded border-slate-300 px-2 py-1 border text-sm"
                    />
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as teamsApi.TeamRole)}
                      className="rounded border-slate-300 px-2 py-1 border text-sm"
                    >
                      <option value="MEMBER">MEMBER</option>
                      <option value="MANAGER">MANAGER</option>
                    </select>
                    <button
                      type="submit"
                      disabled={inviteMut.isPending}
                      className="bg-slate-900 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                  {inviteError && <p className="text-xs text-red-600">{inviteError}</p>}
                  <p className="text-xs text-slate-500">
                    The user must already have a TaskHub account.
                  </p>
                </form>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}

// v1.12: per-team accent colour picker (manager-only). 8 preset swatches +
// a native colour input for arbitrary values. Saves through teamsApi.updateTeam
// + invalidates the cached detail / list so the new value lands everywhere.
const PRESET_COLOURS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#64748b',
];

function TeamColourPicker({ team }: { team: teamsApi.TeamDetail }): JSX.Element {
  const qc = useQueryClient();
  const { refresh } = useTeams();
  const updateMut = useMutation({
    mutationFn: (color: string | null) => teamsApi.updateTeam(team.id, { color }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['teams', 'detail', team.id] }),
        refresh(),
      ]);
    },
  });
  const current = team.color ?? '';
  return (
    <div className="flex items-center gap-1">
      {PRESET_COLOURS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Set colour ${c}`}
          onClick={() => updateMut.mutate(c)}
          className={`w-5 h-5 rounded-full border ${current === c ? 'ring-2 ring-offset-1 ring-slate-900' : 'border-slate-200'}`}
          style={{ background: c }}
        />
      ))}
      <input
        type="color"
        value={current || '#000000'}
        onChange={(e) => updateMut.mutate(e.target.value)}
        title="Custom colour"
        className="w-5 h-5 rounded border border-slate-200 cursor-pointer"
      />
      {team.color && (
        <button
          type="button"
          onClick={() => updateMut.mutate(null)}
          title="Clear colour"
          className="text-xs text-slate-500 underline ml-1"
        >
          clear
        </button>
      )}
    </div>
  );
}
