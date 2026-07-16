import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task, TaskStatus } from '@/features/tasks/api';
import { LabelChip } from '@/features/labels/LabelChip';
import { formatShamsiDate } from '@/lib/shamsi';
import { taskProgressPercent } from './progress';
import type { BoardColumn } from './grouping';

const STATUS_ORDER: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'REVIEW', 'PENDING_APPROVAL', 'DONE'];
const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  // v2.5.58: parked/blocked — entering it prompts for a mandatory hold reason.
  ON_HOLD: 'On hold',
  REVIEW: 'Review',
  // v1.87: system-managed approval state — resolved via approve/reject, not the picker.
  PENDING_APPROVAL: 'Pending approval',
  DONE: 'Done',
};
const PRIORITY_LABEL: Record<Task['priority'], string> = {
  LOW: 'Low',
  MEDIUM: 'Med',
  HIGH: 'High',
  URGENT: 'Urgent',
};
const PRIORITY_CLASS: Record<Task['priority'], string> = {
  LOW: 'text-slate-500',
  MEDIUM: 'text-slate-700',
  HIGH: 'text-warning',
  URGENT: 'text-danger font-semibold',
};

interface CardProps {
  task: Task;
  accent: string;
  columnKey: string;
  draggable: boolean;
  onOpen: (id: string) => void;
  onDelete?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onViewProject?: (task: Task) => void;
  onMarkDone?: (task: Task) => void;
  showProject?: string;
}

function BoardCard({
  task,
  accent,
  columnKey,
  draggable,
  onOpen,
  onDelete,
  onStatusChange,
  onViewProject,
  onMarkDone,
  showProject,
}: CardProps): JSX.Element {
  const sortable = useSortable({
    id: task.id,
    disabled: !draggable,
    data: { columnId: columnKey, kind: 'task' as const },
  });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const style = draggable
    ? {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }
    : undefined;

  return (
    <li
      ref={draggable ? setNodeRef : undefined}
      style={{ ...style, borderLeft: `4px solid ${accent}` }}
      className="rounded border border-border p-2 text-sm bg-surface"
      {...(draggable ? attributes : {})}
    >
      <div className="flex items-start justify-between gap-2">
        {draggable && (
          <span
            {...listeners}
            className="cursor-grab text-slate-400 text-xs select-none"
            aria-label="Drag handle"
          >
            ⋮⋮
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          className="font-medium break-words text-start hover:underline flex-1 min-w-0"
        >
          {task.title}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(task)}
            aria-label="Delete task"
            className="text-xs text-danger hover:underline shrink-0"
          >
            ✕
          </button>
        )}
      </div>
      {showProject && (
        <p className="text-[10px] text-slate-500 mt-0.5 truncate">
          {onViewProject ? (
            <button
              type="button"
              onClick={() => onViewProject(task)}
              className="hover:underline text-primary"
            >
              {showProject}
            </button>
          ) : (
            showProject
          )}
        </p>
      )}
      {task.labels.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      <div className="mt-1 text-[11px] text-slate-500">
        {taskProgressPercent(task)}% · ☑ {task.subtasks.filter((s) => s.done).length}/
        {task.subtasks.length || '—'}
      </div>
      {task.incompleteBlockerCount > 0 && (
        <div className="mt-1 text-[11px] text-warning">🔒 {task.incompleteBlockerCount}</div>
      )}
      <div className="flex items-center justify-between mt-2 gap-2 text-xs flex-wrap">
        <span className={PRIORITY_CLASS[task.priority]}>{PRIORITY_LABEL[task.priority]}</span>
        <div className="flex items-center gap-1">
          {onMarkDone && task.status !== 'DONE' && (
            <button
              type="button"
              onClick={() => onMarkDone(task)}
              className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-600 text-success"
              title="Mark complete"
              aria-label="Mark complete"
            >
              ✓
            </button>
          )}
          {onStatusChange && (
            <select
              value={task.status}
              onChange={(e) => onStatusChange(task, e.target.value as TaskStatus)}
              className="rounded border-slate-300 px-1 py-0.5 border text-xs dark:bg-slate-700"
            >
              {/* v1.87: PENDING_APPROVAL is system-managed — only shown when the
                  task is already there (so the value matches), never selectable. */}
              {STATUS_ORDER.filter((s) => s !== 'PENDING_APPROVAL' || s === task.status).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {task.dueDate && (
        <p className="mt-1 text-[11px] text-slate-500" dir="rtl">
          مهلت {formatShamsiDate(task.dueDate)}
        </p>
      )}
    </li>
  );
}

function BoardColumnShell({
  columnKey,
  label,
  tasks,
  children,
  droppable,
}: {
  columnKey: string;
  label: string;
  tasks: Task[];
  children: React.ReactNode;
  droppable: boolean;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${columnKey}`,
    disabled: !droppable,
    data: { columnId: columnKey, kind: 'column' as const },
  });
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={`bg-surface rounded shadow p-3 min-w-[220px] flex-1 ${
        isOver ? 'ring-2 ring-slate-300' : ''
      }`}
    >
      <h2 className="text-sm font-medium mb-2 flex items-center justify-between">
        <span className="truncate">{label}</span>
        <span className="text-xs text-slate-500 shrink-0 ms-2">{tasks.length}</span>
      </h2>
      <ul className="space-y-2 min-h-[40px]">{children}</ul>
    </div>
  );
}

export interface GroupedBoardProps {
  columns: BoardColumn<string>[];
  accent?: string;
  enableDnD?: boolean;
  onOpen: (taskId: string) => void;
  onDelete?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onViewProject?: (task: Task) => void;
  onMarkDone?: (task: Task) => void;
  onReorder?: (taskId: string, status: TaskStatus, beforeTaskId: string | null) => void;
  projectNames?: Map<string, string>;
}

export default function GroupedBoard({
  columns,
  accent = '#cbd5e1',
  enableDnD = false,
  onOpen,
  onDelete,
  onStatusChange,
  onViewProject,
  onMarkDone,
  onReorder,
  projectNames,
}: GroupedBoardProps): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function onDragEnd(event: DragEndEvent): void {
    if (!onReorder || !enableDnD) return;
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    if (activeId === String(over.id)) return;
    const overData = over.data.current as
      | { columnId?: string; kind?: 'task' | 'column' }
      | undefined;
    let targetStatus: TaskStatus | undefined;
    let beforeTaskId: string | null = null;
    if (overData?.kind === 'task' && overData.columnId) {
      targetStatus = overData.columnId as TaskStatus;
      beforeTaskId = String(over.id);
    } else if (overData?.kind === 'column' && overData.columnId) {
      targetStatus = overData.columnId as TaskStatus;
      beforeTaskId = null;
    }
    if (!targetStatus || !STATUS_ORDER.includes(targetStatus)) return;
    onReorder(activeId, targetStatus, beforeTaskId);
  }

  const grid = (
    <section className="flex gap-4 overflow-x-auto pb-2">
      {columns.map((col) => (
        <BoardColumnShell
          key={col.key}
          columnKey={col.key}
          label={col.label}
          tasks={col.tasks}
          droppable={enableDnD}
        >
          <SortableContext
            items={col.tasks.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            {col.tasks.map((t) => (
              <BoardCard
                key={t.id}
                task={t}
                accent={accent}
                columnKey={col.key}
                draggable={enableDnD}
                onOpen={onOpen}
                onDelete={onDelete}
                onStatusChange={onStatusChange}
                onViewProject={onViewProject}
                onMarkDone={onMarkDone}
                showProject={projectNames?.get(t.projectId)}
              />
            ))}
            {col.tasks.length === 0 && (
              <li className="text-xs text-slate-400 italic py-2">empty</li>
            )}
          </SortableContext>
        </BoardColumnShell>
      ))}
    </section>
  );

  if (enableDnD) {
    return (
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {grid}
      </DndContext>
    );
  }
  return grid;
}
