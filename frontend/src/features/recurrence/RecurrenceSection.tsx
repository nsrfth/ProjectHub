import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  deleteRecurrence,
  getRecurrence,
  upsertRecurrence,
  type Recurrence,
  type RecurrenceFrequency,
  type RecurrenceUpsertInput,
} from './api';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { formatShamsiCalendarLong } from '@/lib/shamsi';

// Phase 4 recurrence section, rendered inside Task detail. The recurrence
// rule attaches to a "source task" — when active, the scheduler clones
// this task on each occurrence (subtask titles + labels copy through;
// completedAt never copies).

interface Props {
  teamId: string;
  projectId: string;
  taskId: string;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function RecurrenceSection({ teamId, projectId, taskId }: Props): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['recurrence', taskId],
    queryFn: () => getRecurrence(teamId, projectId, taskId),
  });

  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open the form pre-filled when an existing rule exists; reset on data
  // change so the form's initial values stay in sync with the server.
  useEffect(() => {
    setShowForm(false);
    setError(null);
  }, [data?.id]);

  const upsertMut = useMutation({
    mutationFn: (input: RecurrenceUpsertInput) => upsertRecurrence(teamId, projectId, taskId, input),
    onSuccess: async () => {
      setShowForm(false);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['recurrence', taskId] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not save recurrence')),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteRecurrence(teamId, projectId, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurrence', taskId] }),
  });

  return (
    <div className="mt-5 pt-4 border-t">
      <h3 className="text-xs font-medium text-slate-600 mb-2">Recurrence</h3>

      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}

      {!isLoading && !data && !showForm && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="text-sm text-slate-700 underline"
        >
          Set up recurrence
        </button>
      )}

      {!isLoading && data && !showForm && (
        <RecurrenceSummary
          rec={data}
          onEdit={() => setShowForm(true)}
          onDelete={() => {
            if (window.confirm('Remove recurrence? Already-spawned tasks stay.')) deleteMut.mutate();
          }}
        />
      )}

      {showForm && (
        <RecurrenceForm
          initial={data ?? undefined}
          pending={upsertMut.isPending}
          error={error}
          onCancel={() => { setShowForm(false); setError(null); }}
          onSubmit={(v) => upsertMut.mutate(v)}
        />
      )}
    </div>
  );
}

function RecurrenceSummary({
  rec, onEdit, onDelete,
}: { rec: Recurrence; onEdit: () => void; onDelete: () => void }): JSX.Element {
  const summary = describeRule(rec);
  return (
    <div className="text-sm">
      <p className="text-slate-700">
        {rec.active ? summary : <span className="text-slate-400 italic">{summary} (paused)</span>}
      </p>
      <p className="text-xs text-slate-500 mt-1">
        Next run: <span dir="rtl">{formatShamsiCalendarLong(rec.nextRunAt)}</span>
        {rec.spawnedCount > 0 && <> · spawned {rec.spawnedCount} so far</>}
        {rec.maxCount && <> / {rec.maxCount}</>}
      </p>
      <div className="flex gap-3 mt-2 text-xs">
        <button onClick={onEdit} className="underline">Edit</button>
        <button onClick={onDelete} className="text-red-600 hover:underline">Remove</button>
      </div>
    </div>
  );
}

function describeRule(rec: Recurrence): string {
  // QUARTERLY uses its own pluralisation because 'quarters' reads better
  // than 'quarterlys' and 'every 1 quarterly' sounds odd. The QUARTERLY
  // case also short-circuits the WEEKLY-byWeekday branch below.
  if (rec.frequency === 'QUARTERLY') {
    return rec.interval === 1 ? 'Every quarter' : `Every ${rec.interval} quarters`;
  }
  const unit = ({
    DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year',
  } as const)[rec.frequency];
  const every = rec.interval === 1 ? `Every ${unit}` : `Every ${rec.interval} ${unit}s`;
  if (rec.frequency === 'WEEKLY' && rec.byWeekday.length > 0) {
    const days = rec.byWeekday.map((d) => WEEKDAY_LABELS[d]).join(', ');
    return `${every} on ${days}`;
  }
  return every;
}

function RecurrenceForm({
  initial, pending, error, onSubmit, onCancel,
}: {
  initial?: Recurrence;
  pending: boolean;
  error: string | null;
  onSubmit: (v: RecurrenceUpsertInput) => void;
  onCancel: () => void;
}): JSX.Element {
  const today = new Date();
  const todayIso = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();

  const [frequency, setFrequency] = useState<RecurrenceFrequency>(initial?.frequency ?? 'DAILY');
  const [interval, setInterval] = useState<number>(initial?.interval ?? 1);
  const [byWeekday, setByWeekday] = useState<number[]>(initial?.byWeekday ?? []);
  const [startsOn, setStartsOn] = useState<string>(initial?.startsOn ?? todayIso);
  const [endsOn, setEndsOn] = useState<string | null>(initial?.endsOn ?? null);
  const [maxCount, setMaxCount] = useState<string>(initial?.maxCount?.toString() ?? '');
  const [dueOffset, setDueOffset] = useState<string>(initial?.dueOffsetDays?.toString() ?? '');
  const [plannedOffset, setPlannedOffset] = useState<string>(initial?.plannedOffsetDays?.toString() ?? '');
  const [active, setActive] = useState<boolean>(initial?.active ?? true);

  function toggleWeekday(d: number): void {
    setByWeekday((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          frequency,
          interval,
          byWeekday: frequency === 'WEEKLY' ? byWeekday : [],
          startsOn,
          endsOn: endsOn ?? null,
          maxCount: maxCount ? Number(maxCount) : null,
          dueOffsetDays: dueOffset === '' ? null : Number(dueOffset),
          plannedOffsetDays: plannedOffset === '' ? null : Number(plannedOffset),
          active,
        });
      }}
      className="space-y-3 text-sm"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Frequency</span>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
            className="border rounded px-2 py-1"
          >
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="YEARLY">Yearly</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Every</span>
          <input
            type="number"
            min={1}
            value={interval}
            onChange={(e) => setInterval(Math.max(1, Number(e.target.value || 1)))}
            className="border rounded px-2 py-1 w-20"
          />
        </label>
      </div>

      {frequency === 'WEEKLY' && (
        <fieldset>
          <legend className="text-xs text-slate-600 mb-1">On weekdays</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_LABELS.map((label, idx) => (
              <label key={idx} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={byWeekday.includes(idx)}
                  onChange={() => toggleWeekday(idx)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Starts on</span>
          <ShamsiDatePicker value={startsOn} onChange={(v) => setStartsOn(v ?? todayIso)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Ends on (optional)</span>
          <ShamsiDatePicker value={endsOn} onChange={setEndsOn} />
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Max occurrences</span>
          <input
            type="number"
            min={1}
            value={maxCount}
            onChange={(e) => setMaxCount(e.target.value)}
            className="border rounded px-2 py-1"
            placeholder="unlimited"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Due offset (days)</span>
          <input
            type="number"
            value={dueOffset}
            onChange={(e) => setDueOffset(e.target.value)}
            className="border rounded px-2 py-1"
            placeholder="—"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-600">Planned offset (days)</span>
          <input
            type="number"
            value={plannedOffset}
            onChange={(e) => setPlannedOffset(e.target.value)}
            className="border rounded px-2 py-1"
            placeholder="—"
          />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        <span className="text-xs">Active</span>
      </label>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save recurrence'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline">Cancel</button>
      </div>
    </form>
  );
}
