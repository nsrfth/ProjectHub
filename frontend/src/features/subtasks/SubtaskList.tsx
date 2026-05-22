import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as subtasksApi from './api';

export interface SubtaskItem {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  position: number;
}

interface SubtaskListProps {
  teamId: string;
  projectId: string;
  taskId: string;
  subtasks: SubtaskItem[];
  // Caller decides what to refresh on every mutation (typically the task
  // detail query + the kanban list so the progress chip stays in sync).
  onChange: () => Promise<void> | void;
}

export function SubtaskList({
  teamId,
  projectId,
  taskId,
  subtasks,
  onChange,
}: SubtaskListProps): JSX.Element {
  const [title, setTitle] = useState('');

  const createMut = useMutation({
    mutationFn: () => subtasksApi.createSubtask(teamId, projectId, taskId, { title }),
    onSuccess: async () => {
      setTitle('');
      await onChange();
    },
  });

  const updateMut = useMutation({
    mutationFn: (input: { id: string; done: boolean }) =>
      subtasksApi.updateSubtask(teamId, projectId, taskId, input.id, { done: input.done }),
    onSuccess: async () => {
      await onChange();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => subtasksApi.deleteSubtask(teamId, projectId, taskId, id),
    onSuccess: async () => {
      await onChange();
    },
  });

  function onAdd(e: FormEvent): void {
    e.preventDefault();
    if (!title.trim()) return;
    createMut.mutate();
  }

  const done = subtasks.filter((s) => s.done).length;
  const total = subtasks.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-600">Subtasks</h3>
        {total > 0 && (
          <span className="text-xs text-slate-500">
            {done} / {total} done
          </span>
        )}
      </div>

      <ul className="space-y-1">
        {subtasks.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.done}
              onChange={(e) => updateMut.mutate({ id: s.id, done: e.target.checked })}
              className="cursor-pointer"
              aria-label={`Mark "${s.title}" ${s.done ? 'incomplete' : 'done'}`}
            />
            <span className={s.done ? 'line-through text-slate-400 flex-1' : 'flex-1'}>
              {s.title}
            </span>
            <button
              type="button"
              onClick={() => deleteMut.mutate(s.id)}
              className="text-xs text-red-600 hover:underline opacity-60 hover:opacity-100"
              aria-label={`Delete subtask ${s.title}`}
            >
              ×
            </button>
          </li>
        ))}
        {total === 0 && <li className="text-xs text-slate-400 italic">No subtasks.</li>}
      </ul>

      <form onSubmit={onAdd} className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Add a subtask…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 rounded border-slate-300 px-2 py-1 border text-sm"
        />
        <button
          type="submit"
          disabled={createMut.isPending || !title.trim()}
          className="bg-slate-900 text-white rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  );
}
