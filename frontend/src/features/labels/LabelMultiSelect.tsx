import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as labelsApi from './api';
import { LabelChip } from './LabelChip';
import { useT } from '@/lib/i18n';

interface LabelMultiSelectProps {
  teamId: string;
  value: string[];
  onChange: (labelIds: string[]) => void;
  disabled?: boolean;
}

const DEFAULT_COLOR = '#64748b';

/** Controlled multi-select over the team label catalog (no per-entity attach API). */
export function LabelMultiSelect({
  teamId,
  value,
  onChange,
  disabled = false,
}: LabelMultiSelectProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const { data: allLabels = [] } = useQuery({
    queryKey: ['labels', teamId],
    queryFn: () => labelsApi.listLabels(teamId),
    enabled: !!teamId && !disabled,
  });

  const selected = allLabels.filter((l) => value.includes(l.id));
  const selectedSet = new Set(value);
  const available = allLabels.filter((l) => !selectedSet.has(l.id));

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => labelsApi.createLabel(teamId, { name, color }),
    onSuccess: async (newLabel) => {
      setName('');
      setColor(DEFAULT_COLOR);
      setShowCreate(false);
      setCreateError(null);
      await qc.invalidateQueries({ queryKey: ['labels', teamId] });
      onChange([...value, newLabel.id]);
    },
    onError: () => setCreateError(t('groups.createFailed')),
  });

  function toggle(labelId: string): void {
    if (disabled) return;
    if (selectedSet.has(labelId)) {
      onChange(value.filter((id) => id !== labelId));
    } else {
      onChange([...value, labelId]);
    }
  }

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate();
  }

  return (
    <div className="space-y-2">
      <span className="text-sm">{t('projects.labels')}</span>
      <div className="flex flex-wrap items-center gap-1.5" dir="ltr">
        {selected.length === 0 && (
          <span className="text-xs text-slate-400 italic">{t('projects.labels.none')}</span>
        )}
        {selected.map((l) => (
          <LabelChip
            key={l.id}
            label={l}
            size="md"
            onRemove={disabled ? undefined : () => toggle(l.id)}
          />
        ))}
      </div>

      {!disabled && available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" dir="ltr">
          <span className="text-xs text-slate-500">{t('projects.labels.add')}:</span>
          {available.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => toggle(l.id)}
              className="opacity-60 hover:opacity-100 transition-opacity"
            >
              <LabelChip label={l} size="md" />
            </button>
          ))}
        </div>
      )}

      {!disabled && !showCreate && (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="text-xs underline text-slate-600 dark:text-slate-300"
        >
          {t('projects.labels.new')}
        </button>
      )}
      {!disabled && showCreate && (
        <form onSubmit={onCreate} className="flex flex-wrap items-center gap-2" dir="ltr">
          <input
            type="text"
            required
            placeholder={t('labels.newPlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 px-2 py-1 border text-sm"
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
            disabled={createMut.isPending || !name.trim()}
            className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
          >
            {t('labels.add')}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCreate(false);
              setName('');
              setCreateError(null);
            }}
            className="text-xs underline"
          >
            {t('projects.edit.cancel')}
          </button>
          {createError && <span className="text-xs text-red-600">{createError}</span>}
        </form>
      )}
    </div>
  );
}
