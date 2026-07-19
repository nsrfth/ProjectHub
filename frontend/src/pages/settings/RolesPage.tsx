import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { useTeams } from '@/features/teams/TeamsContext';
import * as rolesApi from '@/features/roles/api';
import { useT } from '@/lib/i18n';
import { displayRoleName } from '@/lib/displayRoleName';

// v1.23: per-team custom-role CRUD + permission matrix. Lists every role in
// the current team; a click expands an editor with the permission matrix.
// System roles ("Manager", "Member") are editable (permissions only) but
// cannot be deleted. Reaching this page requires team membership; the
// `team.manage_roles` permission gate is enforced by the server on writes.

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function RolesPage(): JSX.Element {
  const t = useT();
  const { currentTeam } = useTeams();
  const qc = useQueryClient();
  const teamId = currentTeam?.id ?? null;

  const { data: rolesResp, isLoading } = useQuery({
    queryKey: ['roles', teamId],
    queryFn: () => rolesApi.listRoles(teamId!),
    enabled: !!teamId,
  });
  const { data: catalog } = useQuery({
    queryKey: ['permissions', 'catalog'],
    queryFn: rolesApi.fetchPermissionCatalog,
    staleTime: 60 * 60_000, // permissions are code-bound; refetch hourly is plenty
  });

  const roles = rolesResp?.items ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPermissions, setNewPermissions] = useState<Set<string>>(new Set());
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      rolesApi.createRole(teamId!, {
        name: newName,
        description: newDescription || null,
        permissions: [...newPermissions],
      }),
    onSuccess: async () => {
      setNewName('');
      setNewDescription('');
      setNewPermissions(new Set());
      setCreateOpen(false);
      setCreateError(null);
      await qc.invalidateQueries({ queryKey: ['roles', teamId] });
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create role')),
  });

  if (!currentTeam) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          Select or <Link to="/teams" className="underline">create a team</Link> first.
        </p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Roles &amp; permissions</h1>
          <p className="text-sm text-slate-500">
            Custom roles for <span className="font-medium">{currentTeam.name}</span>.
            System roles (Manager, Member) are editable but undeletable.
          </p>
        </div>
        {!createOpen && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-sm rounded bg-slate-900 text-white px-3 py-1.5 hover:bg-slate-700"
          >
            + New role
          </button>
        )}
      </div>

      {createOpen && catalog && (
        <section className="bg-surface rounded shadow p-4 mb-6">
          <h2 className="text-sm font-medium mb-3">New role</h2>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (newName.trim()) createMut.mutate();
            }}
            className="space-y-3"
          >
            <input
              type="text"
              required
              placeholder={t('roles.placeholder.name')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded border-border dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
            />
            <textarea
              placeholder={t('roles.placeholder.description')}
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              rows={2}
              className="w-full rounded border-border dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
            />
            <PermissionMatrix
              catalog={catalog}
              selected={newPermissions}
              onChange={setNewPermissions}
            />
            {createError && <p role="alert" className="text-xs text-danger">{createError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMut.isPending || !newName.trim()}
                className="text-sm rounded bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-3 py-1.5 disabled:opacity-50"
              >
                {createMut.isPending ? 'Creating…' : 'Create role'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreateOpen(false);
                  setCreateError(null);
                }}
                className="text-sm rounded border border-border px-3 py-1.5"
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading roles…</p>}

      <div className="space-y-3">
        {roles.map((role) => (
          <RoleCard key={role.id} role={role} catalog={catalog ?? null} teamId={currentTeam.id} />
        ))}
      </div>
    </div>
  );
}

function RoleCard({
  role,
  catalog,
  teamId,
}: {
  role: rolesApi.Role;
  catalog: rolesApi.PermissionCatalog | null;
  teamId: string;
}): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [draftPerms, setDraftPerms] = useState<Set<string>>(() => new Set(role.permissions));
  const [draftName, setDraftName] = useState(role.name);
  const [draftDescription, setDraftDescription] = useState(role.description ?? '');
  const [error, setError] = useState<string | null>(null);

  const savePermsMut = useMutation({
    mutationFn: () => rolesApi.setRolePermissions(teamId, role.id, [...draftPerms]),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['roles', teamId] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not save permissions')),
  });

  const saveMetaMut = useMutation({
    mutationFn: () =>
      rolesApi.updateRole(teamId, role.id, {
        name: draftName,
        description: draftDescription || null,
      }),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['roles', teamId] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not save role')),
  });

  const deleteMut = useMutation({
    mutationFn: () => rolesApi.deleteRole(teamId, role.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles', teamId] }),
    onError: (err) => setError(errorMessage(err, 'Could not delete role')),
  });

  const permsDirty = useMemo(() => {
    if (draftPerms.size !== role.permissions.length) return true;
    for (const p of role.permissions) if (!draftPerms.has(p)) return true;
    return false;
  }, [draftPerms, role.permissions]);

  const metaDirty =
    draftName !== role.name || (draftDescription || null) !== role.description;

  return (
    <section className="bg-surface rounded shadow">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full text-start px-4 py-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium truncate">
              {displayRoleName(role, t)}
              {role.isSystem && displayRoleName(role, t) !== role.name && (
                <span className="ms-1 text-xs text-text-muted font-normal">({role.name})</span>
              )}
            </h3>
            {role.isSystem && (
              <span className="text-[10px] uppercase tracking-wide bg-slate-200 dark:bg-slate-700 text-text rounded px-1.5 py-0.5">
                System
              </span>
            )}
          </div>
          {role.description && (
            <p className="text-xs text-text-muted mt-0.5 truncate">
              {role.description}
            </p>
          )}
          <p className="text-xs text-slate-400 mt-1">
            {role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'} · {role.membershipCount} member{role.membershipCount === 1 ? '' : 's'}
          </p>
        </div>
        <span className="text-xs text-slate-400">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && catalog && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Name + description edit */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-2">
            <input
              type="text"
              disabled={role.isSystem}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="rounded border-border dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm disabled:opacity-60"
              title={role.isSystem ? 'System role names cannot be changed' : ''}
            />
            <input
              type="text"
              placeholder={t('roles.placeholder.descriptionShort')}
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              className="rounded border-border dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
            />
          </div>
          {metaDirty && (
            <button
              type="button"
              onClick={() => saveMetaMut.mutate()}
              disabled={saveMetaMut.isPending}
              className="text-xs rounded bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-2 py-1 disabled:opacity-50"
            >
              {saveMetaMut.isPending ? 'Saving…' : 'Save name/description'}
            </button>
          )}

          {/* Permission matrix */}
          <PermissionMatrix catalog={catalog} selected={draftPerms} onChange={setDraftPerms} />

          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={() => savePermsMut.mutate()}
              disabled={!permsDirty || savePermsMut.isPending}
              className="text-sm rounded bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-3 py-1 disabled:opacity-50"
            >
              {savePermsMut.isPending ? 'Saving…' : 'Save permissions'}
            </button>
            <button
              type="button"
              onClick={() => setDraftPerms(new Set(role.permissions))}
              disabled={!permsDirty}
              className="text-sm rounded border border-border px-3 py-1 disabled:opacity-50"
            >
              Discard
            </button>
            {!role.isSystem && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete role "${role.name}"?`)) deleteMut.mutate();
                }}
                disabled={deleteMut.isPending || role.membershipCount > 0}
                className="ms-auto text-sm text-danger disabled:opacity-50"
                title={
                  role.membershipCount > 0
                    ? 'Reassign all members before deleting'
                    : 'Delete this role'
                }
              >
                {deleteMut.isPending ? 'Deleting…' : 'Delete role'}
              </button>
            )}
          </div>

          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </section>
  );
}

function PermissionMatrix({
  catalog,
  selected,
  onChange,
}: {
  catalog: rolesApi.PermissionCatalog;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}): JSX.Element {
  function toggle(perm: string) {
    const next = new Set(selected);
    if (next.has(perm)) next.delete(perm);
    else next.add(perm);
    onChange(next);
  }
  return (
    <div className="space-y-3">
      {Object.entries(catalog.groups).map(([group, perms]) => (
        <fieldset key={group} className="border border-border rounded p-3">
          <legend className="px-1 text-xs uppercase tracking-wide text-text-muted">
            {group}
          </legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
            {perms.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(p)}
                  onChange={() => toggle(p)}
                />
                <code className="text-xs">{p}</code>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
