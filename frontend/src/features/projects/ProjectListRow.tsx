import { Link } from 'react-router-dom';
import type { ProjectCrossTeam } from '@/features/projects/api';
import ProjectActionsMenu from '@/features/projects/ProjectActionsMenu';
import { shouldShowProjectActionsMenu } from '@/features/projects/projectActionsLogic';
import { LabelChip } from '@/features/labels/LabelChip';
import { budgetLocaleFromLanguage, formatBudget } from '@/lib/formatBudget';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import { getLanguage, useT } from '@/lib/i18n';

export interface ProjectListRowProps {
  project: ProjectCrossTeam;
  userId?: string;
  canManage: boolean;
  bucketNames: string[];
  actionsMenuOpen: boolean;
  actionsMenuRef?: React.RefObject<HTMLDivElement>;
  onToggleActionsMenu: (e: React.MouseEvent) => void;
  onCloseActionsMenu: () => void;
  onOpen: () => void;
  onEditProject: () => void;
  onEditBudget: () => void;
  onDelete: () => void;
  bucketMenu: React.ReactNode;
}

export default function ProjectListRow({
  project,
  userId,
  canManage,
  bucketNames,
  actionsMenuOpen,
  actionsMenuRef,
  onToggleActionsMenu,
  onCloseActionsMenu,
  onOpen,
  onEditProject,
  onEditBudget,
  onDelete,
  bucketMenu,
}: ProjectListRowProps): JSX.Element {
  const t = useT();
  const locale = budgetLocaleFromLanguage(getLanguage());
  const showActions = shouldShowProjectActionsMenu(canManage);

  const statusLabel = t(
    `projects.status.${project.status === 'ON_HOLD' ? 'onHold' : project.status.toLowerCase()}` as never,
  );

  function handleEdit(): void {
    onCloseActionsMenu();
    onEditProject();
  }

  function handleBudget(): void {
    onCloseActionsMenu();
    onEditBudget();
  }

  function handleDelete(): void {
    onCloseActionsMenu();
    if (window.confirm(t('projects.delete.confirm').replace('{name}', project.name))) {
      onDelete();
    }
  }

  const hasBudget = !!project.plannedBudget;
  const fmt = (s: string | null): string => formatBudget(s, project.budgetCurrency, locale);

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="text-left min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={onOpen} className="font-medium truncate hover:underline">
              {project.name}
            </button>
            <span className="text-xs uppercase tracking-wide text-slate-500 shrink-0">
              {statusLabel}
            </span>
            {(project.labels?.length ?? 0) > 0 && (
              <span className="flex flex-wrap items-center gap-1" dir="ltr">
                {(project.labels ?? []).map((l) => (
                  <LabelChip key={l.id} label={l} />
                ))}
              </span>
            )}
          </div>
          {project.description && (
            <button
              type="button"
              onClick={onOpen}
              className="text-sm text-slate-600 dark:text-slate-300 mt-0.5 truncate block hover:underline w-full text-left"
            >
              {project.description}
            </button>
          )}
          {bucketNames.length > 0 && (
            <p className="text-[11px] text-indigo-600 dark:text-indigo-400 mt-0.5 truncate">
              {bucketNames.join(' · ')}
            </p>
          )}
          <p className="text-xs text-slate-400 mt-1">
            {t('projects.ownedBy').replace('{owner}', project.ownerId === userId ? t('projects.ownedByYou') : project.ownerId?.slice(0, 8) ?? '—')}
            {' · '}
            <span dir="rtl">ایجاد {formatShamsiTimestampDate(project.createdAt)}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-1">
            {bucketMenu}
            {showActions && (
              <ProjectActionsMenu
                open={actionsMenuOpen}
                menuRef={actionsMenuRef}
                onToggle={onToggleActionsMenu}
                onEdit={handleEdit}
                onEditBudget={handleBudget}
                onDelete={handleDelete}
              />
            )}
          </div>
          <span className="text-[11px] uppercase rounded-full bg-slate-100 dark:bg-slate-700 px-2 py-0.5">
            {project.teamName}
          </span>
          <Link
            to={`/projects/${project.id}/reports/gantt`}
            className="text-xs text-indigo-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Gantt
          </Link>
        </div>
      </div>
      {(hasBudget || canManage) && (
        <div className="mt-2 ml-7 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2 flex-wrap">
          <span className="font-medium">{t('projects.budget.label')}:</span>
          <span dir="ltr" className="inline-block">
            {t('projects.budget.planned')} <code>{fmt(project.plannedBudget)}</code>
          </span>
        </div>
      )}
    </li>
  );
}
