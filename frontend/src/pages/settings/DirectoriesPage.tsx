import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  createDirectory,
  deleteDirectory,
  listDirectories,
  testDirectory,
  updateDirectory,
  type Directory,
  type DirectoryCreateInput,
} from '@/features/directories/api';
import ScimPanel from '@/features/directories/ScimPanel';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

const DEFAULT_FORM: DirectoryCreateInput = {
  name: '',
  slug: '',
  kind: 'LDAP',
  host: '',
  port: 389,
  useTLS: false,
  bindDN: '',
  bindPassword: '',
  baseDN: '',
  userIdAttr: 'uid',
  emailAttr: 'mail',
  nameAttr: 'cn',
  groupMemberAttr: 'member',
  allowJIT: true,
  syncRolesFromGroups: false,
};

export default function DirectoriesPage(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['directories'],
    queryFn: listDirectories,
  });

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Directory | null>(null);
  const [form, setForm] = useState<DirectoryCreateInput>(DEFAULT_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);

  const createMut = useMutation({
    mutationFn: createDirectory,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['directories'] });
      setShowForm(false);
      setForm(DEFAULT_FORM);
      setFormError(null);
    },
    onError: (err) => setFormError(errorMessage(err, 'Could not create directory')),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, input }: { id: string; input: DirectoryCreateInput }) =>
      updateDirectory(id, input),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['directories'] });
      setEditing(null);
      setFormError(null);
    },
    onError: (err) => setFormError(errorMessage(err, 'Could not update directory')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteDirectory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['directories'] }),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => testDirectory(id),
    onSuccess: (res, id) => setTestResult({ id, ok: res.ok, message: res.message }),
    onError: (err, id) => setTestResult({ id, ok: false, message: errorMessage(err, 'Test failed') }),
  });

  function startEdit(d: Directory): void {
    setEditing(d);
    setForm({
      name: d.name,
      slug: d.slug,
      kind: d.kind,
      host: d.host ?? '',
      port: d.port ?? 389,
      useTLS: d.useTLS,
      bindDN: d.bindDN ?? '',
      // Leave password empty; only send if the admin retypes it.
      bindPassword: '',
      baseDN: d.baseDN ?? '',
      userFilter: d.userFilter ?? '',
      groupFilter: d.groupFilter ?? '',
      userIdAttr: d.userIdAttr,
      emailAttr: d.emailAttr,
      nameAttr: d.nameAttr,
      groupMemberAttr: d.groupMemberAttr,
      allowJIT: d.allowJIT,
      syncRolesFromGroups: d.syncRolesFromGroups,
    });
    setFormError(null);
    setShowForm(true);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    // Strip empty password so we don't accidentally clear it.
    const payload: DirectoryCreateInput = { ...form };
    if (!payload.bindPassword) delete payload.bindPassword;
    if (editing) {
      updateMut.mutate({ id: editing.id, input: payload });
    } else {
      createMut.mutate(payload);
    }
  }

  return (
    <section>
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold mb-1">Directories</h2>
          <p className="text-sm text-slate-500">
            LDAP / SCIM identity providers. Users can log in with their directory
            password once a directory is bound.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setForm(DEFAULT_FORM);
              setShowForm(true);
            }}
            className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium"
          >
            New directory
          </button>
        )}
      </header>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Could not load directories.</p>}

      {!isLoading && data && data.items.length === 0 && !showForm && (
        <p className="text-sm text-slate-500 italic">
          No directories configured yet.
        </p>
      )}

      <ul className="space-y-2 mb-6">
        {data?.items.map((d) => (
          <li key={d.id} className="border rounded p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{d.name}</p>
                <p className="text-xs text-slate-500 truncate">
                  {d.kind} · {d.host}:{d.port} · base {d.baseDN ?? '—'} ·{' '}
                  {d.useTLS ? 'TLS' : 'plain'} ·{' '}
                  {d.hasBindPassword ? 'password set' : 'no password'} ·{' '}
                  JIT {d.allowJIT ? 'on' : 'off'} ·{' '}
                  groups {d.syncRolesFromGroups ? 'sync' : 'off'}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => testMut.mutate(d.id)}
                  disabled={testMut.isPending}
                  className="text-xs underline disabled:opacity-50"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(d)}
                  className="text-xs underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete "${d.name}"? Local users they own keep their accounts.`)) {
                      deleteMut.mutate(d.id);
                    }
                  }}
                  className="text-xs text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
            </div>
            {testResult?.id === d.id && (
              <p
                className={`mt-2 text-xs ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}
              >
                {testResult.ok ? '✓ ' : '✗ '}
                {testResult.message}
              </p>
            )}

            <ScimPanel
              directoryId={d.id}
              // Caddy fronts the API on the same host as the SPA; SCIM IdPs
              // will hit the public URL. window.location.origin gives the
              // hostname the admin is currently using to view this page.
              scimBaseUrl={`${window.location.origin}/api/scim/v2`}
            />
          </li>
        ))}
      </ul>

      {showForm && (
        <form onSubmit={submit} className="bg-slate-50 rounded border p-4 space-y-3">
          <h3 className="text-sm font-medium">
            {editing ? `Edit ${editing.name}` : 'New directory'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Name</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Slug</span>
              <input
                required
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="border rounded px-2 py-1"
                placeholder="acme-ldap"
              />
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs text-slate-600">Host</span>
              <input
                value={form.host ?? ''}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                className="border rounded px-2 py-1"
                placeholder="ldap.example.com"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Port</span>
              <input
                type="number"
                value={form.port ?? ''}
                onChange={(e) => setForm({ ...form, port: e.target.value ? Number(e.target.value) : undefined })}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 mt-5">
              <input
                type="checkbox"
                checked={form.useTLS ?? false}
                onChange={(e) => setForm({ ...form, useTLS: e.target.checked })}
              />
              <span className="text-xs">Use TLS (ldaps)</span>
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs text-slate-600">Bind DN</span>
              <input
                value={form.bindDN ?? ''}
                onChange={(e) => setForm({ ...form, bindDN: e.target.value })}
                className="border rounded px-2 py-1"
                placeholder="cn=admin,dc=example,dc=org"
              />
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs text-slate-600">
                Bind password{' '}
                {editing && (
                  <span className="text-slate-400">
                    ({editing.hasBindPassword ? 'set — leave empty to keep' : 'not set'})
                  </span>
                )}
              </span>
              <input
                type="password"
                value={form.bindPassword ?? ''}
                onChange={(e) => setForm({ ...form, bindPassword: e.target.value })}
                className="border rounded px-2 py-1"
                autoComplete="new-password"
              />
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs text-slate-600">Base DN</span>
              <input
                value={form.baseDN ?? ''}
                onChange={(e) => setForm({ ...form, baseDN: e.target.value })}
                className="border rounded px-2 py-1"
                placeholder="ou=People,dc=example,dc=org"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Email attr</span>
              <input
                value={form.emailAttr ?? 'mail'}
                onChange={(e) => setForm({ ...form, emailAttr: e.target.value })}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Name attr</span>
              <input
                value={form.nameAttr ?? 'cn'}
                onChange={(e) => setForm({ ...form, nameAttr: e.target.value })}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">User-ID attr</span>
              <input
                value={form.userIdAttr ?? 'uid'}
                onChange={(e) => setForm({ ...form, userIdAttr: e.target.value })}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Group-member attr</span>
              <input
                value={form.groupMemberAttr ?? 'member'}
                onChange={(e) => setForm({ ...form, groupMemberAttr: e.target.value })}
                className="border rounded px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 mt-4">
              <input
                type="checkbox"
                checked={form.allowJIT ?? true}
                onChange={(e) => setForm({ ...form, allowJIT: e.target.checked })}
              />
              <span className="text-xs">Allow JIT provisioning</span>
            </label>
            <label className="flex items-center gap-2 mt-4">
              <input
                type="checkbox"
                checked={form.syncRolesFromGroups ?? false}
                onChange={(e) => setForm({ ...form, syncRolesFromGroups: e.target.checked })}
              />
              <span className="text-xs">Sync roles from group mappings</span>
            </label>
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={createMut.isPending || updateMut.isPending}
              className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
            >
              {editing ? 'Save changes' : 'Create directory'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
                setFormError(null);
              }}
              className="text-sm underline"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
