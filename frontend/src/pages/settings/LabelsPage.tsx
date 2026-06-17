import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useTeams } from '@/features/teams/TeamsContext';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';
import { LabelChip } from '@/features/labels/LabelChip';
import * as labelsApi from '@/features/labels/api';

// v1.36: standalone Labels management page. Lives under Settings →
// Labels (matches the Roles / Directories / Security pattern). Operates
// on the page-level currentTeam — labels are team-scoped, so picking a
// team upstream (sidebar context) is the right entry point.
//
// Permission gating: the backend's labels endpoints don't check a
// specific permission today (any team member can manage labels in this
// codebase), so the page surfaces every affordance to every member. A
// 403 surfaces as an inline alert.

const DEFAULT_COLOR = '#64748b'; // slate-500

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function LabelsPage(): JSX.Element {
  const { currentTeam } = useTeams();
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'ADMIN';
  const t = useT();
  const qc = useQueryClient();
  const teamId = currentTeam?.id ?? null;

  // The team catalog now includes global predefined labels (isPredefined).
  // Split them: team labels are managed here by anyone; predefined labels
  // are managed by a global ADMIN in the section above.
  const { data: labels = [], isLoading } = useQuery({
    queryKey: ['labels', teamId],
    queryFn: () => labelsApi.listLabels(teamId!),
    enabled: !!teamId,
  });
  const teamLabels = labels.filter((l) => !l.isPredefined);
  const predefinedLabels = labels.filter((l) => l.isPredefined);

  // ── Team-label mutations ──
  const createMut = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      labelsApi.createLabel(teamId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['labels', teamId] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not create label')),
  });
  const updateMut = useMutation({
    mutationFn: (input: { labelId: string; name?: string; color?: string }) =>
      labelsApi.updateLabel(teamId!, input.labelId, { name: input.name, color: input.color }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['labels', teamId] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not update label')),
  });
  const deleteMut = useMutation({
    mutationFn: (labelId: string) => labelsApi.deleteLabel(teamId!, labelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['labels', teamId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not delete label')),
  });

  // ── Global predefined-label mutations (admin only). Invalidate every
  //    team's catalog since globals appear everywhere. ──
  const createGlobalMut = useMutation({
    mutationFn: (input: { name: string; color: string }) => labelsApi.createGlobalLabel(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['labels'] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not create predefined label')),
  });
  const updateGlobalMut = useMutation({
    mutationFn: (input: { labelId: string; name?: string; color?: string }) =>
      labelsApi.updateGlobalLabel(input.labelId, { name: input.name, color: input.color }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['labels'] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not update predefined label')),
  });
  const deleteGlobalMut = useMutation({
    mutationFn: (labelId: string) => labelsApi.deleteGlobalLabel(labelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['labels'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not delete predefined label')),
  });

  if (!currentTeam) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('labels.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('labels.selectTeam')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-8">
      {/* Predefined (global) labels — global ADMIN only. */}
      {isAdmin && (
        <div className="space-y-4">
          <header>
            <h2 className="text-lg font-semibold mb-1">{t('labels.predefined.title')}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t('labels.predefined.subtitle')}
            </p>
          </header>
          {predefinedLabels.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 italic">
              {t('labels.predefined.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded">
              {predefinedLabels.map((l) => (
                <LabelRow
                  key={l.id}
                  label={l}
                  busy={updateGlobalMut.isPending || deleteGlobalMut.isPending}
                  onRename={(name) => updateGlobalMut.mutate({ labelId: l.id, name })}
                  onRecolor={(color) => updateGlobalMut.mutate({ labelId: l.id, color })}
                  onDelete={() => {
                    if (window.confirm(t('labels.deleteConfirm').replace('{name}', l.name))) {
                      deleteGlobalMut.mutate(l.id);
                    }
                  }}
                  t={t}
                />
              ))}
            </ul>
          )}
          <CreateLabelForm
            onCreate={(input) => createGlobalMut.mutate(input)}
            submitting={createGlobalMut.isPending}
            t={t}
          />
        </div>
      )}

      {/* Team (user-defined) labels. */}
      <div className="space-y-4">
        <header>
          <h2 className="text-lg font-semibold mb-1">{t('labels.title')}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('labels.subtitle').replace('{team}', currentTeam.name)}
          </p>
        </header>

        {isLoading && <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>}

        {!isLoading && teamLabels.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400 italic">{t('labels.empty')}</p>
        )}

        {!isLoading && teamLabels.length > 0 && (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded">
            {teamLabels.map((l) => (
              <LabelRow
                key={l.id}
                label={l}
                busy={updateMut.isPending || deleteMut.isPending}
                onRename={(name) => updateMut.mutate({ labelId: l.id, name })}
                onRecolor={(color) => updateMut.mutate({ labelId: l.id, color })}
                onDelete={() => {
                  if (window.confirm(t('labels.deleteConfirm').replace('{name}', l.name))) {
                    deleteMut.mutate(l.id);
                  }
                }}
                t={t}
              />
            ))}
          </ul>
        )}

        {teamId && (
          <CreateLabelForm
            onCreate={(input) => createMut.mutate(input)}
            submitting={createMut.isPending}
            t={t}
          />
        )}
      </div>
    </section>
  );
}

// ── Single row: chip preview + inline rename + color picker + delete ────

function LabelRow({
  label,
  busy,
  onRename,
  onRecolor,
  onDelete,
  t,
}: {
  label: labelsApi.Label;
  busy: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
  t: (k: string) => string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);

  function commit(): void {
    const trimmed = name.trim();
    setEditing(false);
    if (trimmed && trimmed !== label.name) onRename(trimmed);
    else setName(label.name);
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setName(label.name);
      setEditing(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="w-32 shrink-0">
        <LabelChip label={label} size="md" />
      </span>
      {editing ? (
        <input
          autoFocus
          type="text"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          className="flex-1 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setName(label.name);
            setEditing(true);
          }}
          className="flex-1 text-left hover:underline text-slate-800 dark:text-slate-100"
          title={t('labels.rename')}
        >
          {label.name}
        </button>
      )}
      <input
        type="color"
        value={label.color}
        onChange={(e) => onRecolor(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded border border-slate-300 dark:border-slate-600"
        aria-label={t('labels.recolor')}
        title={t('labels.recolor')}
        disabled={busy}
      />
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="text-xs text-red-600 hover:underline disabled:opacity-50"
        title={t('labels.delete')}
      >
        {t('labels.delete')}
      </button>
    </li>
  );
}

// ── Inline create form ──────────────────────────────────────────────────

function CreateLabelForm({
  onCreate,
  submitting,
  t,
}: {
  onCreate: (input: { name: string; color: string }) => void;
  submitting: boolean;
  t: (k: string) => string;
}): JSX.Element {
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate({ name: trimmed, color });
    setName('');
    setColor(DEFAULT_COLOR);
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-700"
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('labels.newPlaceholder')}
        maxLength={40}
        className="flex-1 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm"
      />
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-8 w-10 cursor-pointer rounded border border-slate-300 dark:border-slate-600"
        aria-label={t('labels.color')}
      />
      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
      >
        {submitting ? t('labels.adding') : t('labels.add')}
      </button>
    </form>
  );
}
