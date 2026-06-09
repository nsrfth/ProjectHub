import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ProjectCrossTeam } from '@/features/projects/api';
import type { ProjectBucket } from './api';
import { bucketBudgetSummary } from './filters';

interface ProjectCardProps {
  project: ProjectCrossTeam;
  bucketId: string;
  accent: string;
  onOpen: (projectId: string) => void;
  menu?: React.ReactNode;
}

function ProjectCard({ project, bucketId, accent, onOpen, menu }: ProjectCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `project:${bucketId}:${project.id}`,
    data: { kind: 'project' as const, bucketId, projectId: project.id },
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        borderLeftColor: accent,
      }}
      className="rounded border border-slate-200 dark:border-slate-600 border-l-4 p-2 bg-white dark:bg-slate-800 text-sm"
      {...attributes}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          {...listeners}
          className="cursor-grab text-slate-400 text-xs select-none shrink-0"
          aria-label="Drag project"
        >
          ⋮⋮
        </button>
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          className="font-medium text-left hover:underline flex-1 min-w-0 truncate"
        >
          {project.name}
        </button>
        {menu}
      </div>
      <p className="text-[10px] text-slate-500 mt-1 truncate">{project.teamName}</p>
    </li>
  );
}

function BucketColumn({
  bucket,
  projects,
  collapsed,
  onToggleCollapse,
  onEdit,
  onDelete,
  onOpen,
  renderMenu,
}: {
  bucket: ProjectBucket;
  projects: ProjectCrossTeam[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpen: (id: string) => void;
  renderMenu: (project: ProjectCrossTeam) => React.ReactNode;
}): JSX.Element {
  const accent = bucket.color ?? '#94a3b8';
  const { setNodeRef, isOver } = useDroppable({
    id: `bucket:${bucket.id}`,
    data: { kind: 'column' as const, bucketId: bucket.id },
  });
  const summary = bucketBudgetSummary(
    bucket.projectIds,
    new Map(projects.map((p) => [p.id, p])),
  );

  return (
    <div
      ref={setNodeRef}
      className={`bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 min-w-[240px] max-w-[280px] flex-1 flex flex-col ${
        isOver ? 'ring-2 ring-indigo-400' : ''
      }`}
    >
      <div className="flex items-start gap-2 mb-2">
        <span
          className="w-3 h-3 rounded-full shrink-0 mt-1"
          style={{ backgroundColor: accent }}
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm truncate">{bucket.name}</h3>
          {bucket.description && (
            <p className="text-[11px] text-slate-500 truncate">{bucket.description}</p>
          )}
          <p className="text-[10px] text-slate-400 mt-0.5">
            {projects.length} project{projects.length === 1 ? '' : 's'}
            {summary.planned > 0 && (
              <span title="Future: budget rollup">
                {' '}
                · budget {summary.planned.toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <button type="button" onClick={onToggleCollapse} className="text-xs text-slate-400">
            {collapsed ? '▼' : '▲'}
          </button>
          <button type="button" onClick={onEdit} className="text-xs text-slate-500 hover:underline">
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-red-600 hover:underline"
          >
            Del
          </button>
        </div>
      </div>
      {!collapsed && (
        <SortableContext
          items={projects.map((p) => `project:${bucket.id}:${p.id}`)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-2 min-h-[48px] flex-1">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                bucketId={bucket.id}
                accent={accent}
                onOpen={onOpen}
                menu={renderMenu(p)}
              />
            ))}
            {projects.length === 0 && (
              <li className="text-xs text-slate-400 italic py-4 text-center">Drop projects here</li>
            )}
          </ul>
        </SortableContext>
      )}
    </div>
  );
}

function SortableBucketShell({
  bucket,
  children,
}: {
  bucket: ProjectBucket;
  children: React.ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: `bucket-sort:${bucket.id}`,
    data: { kind: 'bucket' as const, bucketId: bucket.id },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="shrink-0"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="text-[10px] text-slate-400 mb-1 cursor-grab block w-full text-center"
        aria-label={`Reorder ${bucket.name}`}
      >
        ≡ drag bucket
      </button>
      {children}
    </div>
  );
}

export interface ProjectBucketBoardProps {
  buckets: ProjectBucket[];
  projectsById: Map<string, ProjectCrossTeam>;
  collapsed: Set<string>;
  onToggleCollapse: (bucketId: string) => void;
  onOpenProject: (projectId: string) => void;
  onEditBucket: (bucket: ProjectBucket) => void;
  onDeleteBucket: (bucket: ProjectBucket) => void;
  onReorderBuckets: (bucketIds: string[]) => void;
  onAddToBucket: (bucketId: string, projectId: string) => void;
  onReorderInBucket: (bucketId: string, projectIds: string[]) => void;
  renderProjectMenu: (project: ProjectCrossTeam) => React.ReactNode;
}

export default function ProjectBucketBoard({
  buckets,
  projectsById,
  collapsed,
  onToggleCollapse,
  onOpenProject,
  onEditBucket,
  onDeleteBucket,
  onReorderBuckets,
  onAddToBucket,
  onReorderInBucket,
  renderProjectMenu,
}: ProjectBucketBoardProps): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current as
      | { kind: 'project'; bucketId: string; projectId: string }
      | { kind: 'bucket'; bucketId: string }
      | undefined;
    const overData = over.data.current as
      | { kind: 'project'; bucketId: string; projectId: string }
      | { kind: 'column'; bucketId: string }
      | { kind: 'bucket'; bucketId: string }
      | undefined;

    if (activeData?.kind === 'bucket' && overData?.kind === 'bucket') {
      const ids = buckets.map((b) => b.id);
      const from = ids.indexOf(activeData.bucketId);
      const to = ids.indexOf(overData.bucketId);
      if (from >= 0 && to >= 0 && from !== to) {
        onReorderBuckets(arrayMove(ids, from, to));
      }
      return;
    }

    if (activeData?.kind !== 'project') return;

    const sourceBucketId = activeData.bucketId;
    const projectId = activeData.projectId;

    if (overData?.kind === 'column') {
      if (overData.bucketId !== sourceBucketId) {
        onAddToBucket(overData.bucketId, projectId);
      }
      return;
    }

    const overId = String(over.id);
    if (!overId.startsWith('project:')) return;

    let targetBucketId = sourceBucketId;

    if (overData?.kind === 'project') targetBucketId = overData.bucketId;
    else if (overId.startsWith('project:')) {
      targetBucketId = overId.split(':')[1]!;
    }

    if (targetBucketId !== sourceBucketId) {
      onAddToBucket(targetBucketId, projectId);
      return;
    }

    const bucket = buckets.find((b) => b.id === sourceBucketId);
    if (!bucket) return;
    const ids = bucket.projectIds.filter((id) => projectsById.has(id));
    const from = ids.indexOf(projectId);
    const overProjectId = overId.split(':')[2];
    const to = overProjectId ? ids.indexOf(overProjectId) : -1;
    if (from >= 0 && to >= 0 && from !== to) {
      onReorderInBucket(sourceBucketId, arrayMove(ids, from, to));
    }
  }

  if (buckets.length === 0) {
    return (
      <p className="text-sm text-slate-500 italic py-8 text-center">
        Create your first personal bucket to organize projects.
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
      <SortableContext
        items={buckets.map((b) => `bucket-sort:${b.id}`)}
        strategy={horizontalListSortingStrategy}
      >
        <section className="flex gap-4 overflow-x-auto pb-4 items-start">
          {buckets.map((bucket) => {
            const projects = bucket.projectIds
              .map((id) => projectsById.get(id))
              .filter((p): p is ProjectCrossTeam => !!p);
            return (
              <SortableBucketShell key={bucket.id} bucket={bucket}>
                <BucketColumn
                  bucket={bucket}
                  projects={projects}
                  collapsed={collapsed.has(bucket.id)}
                  onToggleCollapse={() => onToggleCollapse(bucket.id)}
                  onEdit={() => onEditBucket(bucket)}
                  onDelete={() => onDeleteBucket(bucket)}
                  onOpen={onOpenProject}
                  renderMenu={renderProjectMenu}
                />
              </SortableBucketShell>
            );
          })}
        </section>
      </SortableContext>
    </DndContext>
  );
}
