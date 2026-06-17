import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as labelsApi from './api';
import { LabelChip } from './LabelChip';

interface LabelPickerProps {
  teamId: string;
  projectId: string;
  taskId: string;
  // Labels currently attached to this task. The component invalidates the
  // parent query (task detail / tasks list) on every attach/detach via the
  // onChange callback so the caller can refresh whatever needs refreshing.
  attached: labelsApi.TaskLabel[];
  onChange: () => Promise<void> | void;
}

const DEFAULT_COLOR = '#64748b'; // slate-500 — neutral fallback for the colour input

// Attach / detach UI for one task, plus an inline "create new label" form.
// Mounted on the task detail page; the kanban cards just render `LabelChip`s.
export function LabelPicker({
  teamId,
  projectId,
  taskId,
  attached,
  onChange,
}: LabelPickerProps): JSX.Element {
  const qc = useQueryClient();
  const { data: allLabels = [] } = useQuery({
    queryKey: ['labels', teamId],
    queryFn: () => labelsApi.listLabels(teamId),
    enabled: !!teamId,
  });

  const attachedIds = new Set(attached.map((l) => l.id));
  const unattached = allLabels.filter((l) => !attachedIds.has(l.id));
  // v1.80: group attach options — global "predefined" labels vs this team's own.
  const unattachedPredefined = unattached.filter((l) => l.isPredefined);
  const unattachedTeam = unattached.filter((l) => !l.isPredefined);

  const attachMut = useMutation({
    mutationFn: (labelId: string) => labelsApi.attachLabel(teamId, projectId, taskId, labelId),
    onSuccess: async () => {
      await onChange();
    },
  });

  const detachMut = useMutation({
    mutationFn: (labelId: string) => labelsApi.detachLabel(teamId, projectId, taskId, labelId),
    onSuccess: async () => {
      await onChange();
    },
  });

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
      // Auto-attach the new label so the typical flow is one click instead of two.
      attachMut.mutate(newLabel.id);
    },
    onError: () => setCreateError('Could not create label (name may already exist)'),
  });

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {attached.length === 0 && (
          <span className="text-xs text-slate-400 italic">No labels.</span>
        )}
        {attached.map((l) => (
          <LabelChip
            key={l.id}
            label={l}
            size="md"
            onRemove={() => detachMut.mutate(l.id)}
          />
        ))}
      </div>

      {unattachedPredefined.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Predefined:</span>
          {unattachedPredefined.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => attachMut.mutate(l.id)}
              className="opacity-60 hover:opacity-100 transition-opacity"
            >
              <LabelChip label={l} size="md" />
            </button>
          ))}
        </div>
      )}

      {unattachedTeam.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Add:</span>
          {unattachedTeam.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => attachMut.mutate(l.id)}
              className="opacity-60 hover:opacity-100 transition-opacity"
            >
              <LabelChip label={l} size="md" />
            </button>
          ))}
        </div>
      )}

      {!showCreate && (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="text-xs underline text-slate-600"
        >
          + New label
        </button>
      )}
      {showCreate && (
        <form onSubmit={onCreate} className="flex items-center gap-2">
          <input
            type="text"
            required
            placeholder="Label name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border-slate-300 px-2 py-1 border text-sm"
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-slate-300"
            aria-label="Label color"
          />
          <button
            type="submit"
            disabled={createMut.isPending || !name.trim()}
            className="bg-slate-900 text-white rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
          >
            Create
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
            Cancel
          </button>
          {createError && <span className="text-xs text-red-600">{createError}</span>}
        </form>
      )}
    </div>
  );
}
