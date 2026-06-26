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
        <div className="text-start min-w-0 flex-1">
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
              className="text-sm text-text mt-0.5 truncate block hover:underline w-full text-start"
            >
              {project.description}
            </button>
          )}
          {bucketNames.length > 0 && (
            <p className="text-[11px] text-primary mt-0.5 truncate">
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
          <span className="text-[11px] uppercase rounded-full bg-bg-elevated px-2 py-0.5">
            {project.teamName}
          </span>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <Link
              to={`/projects/${project.id}/reports/status`}
              title={t('projects.status.view')}
              aria-label={t('projects.status.view')}
              className="text-primary hover:text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 3v18h18" />
                <path d="M18 17V9" />
                <path d="M13 17V5" />
                <path d="M8 17v-3" />
              </svg>
            </Link>
            <Link
              to={`/projects/${project.id}/reports/gantt`}
              className="text-xs text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Gantt
            </Link>
            <Link
              to={`/projects/${project.id}/records`}
              className="text-xs text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {t('records.navShort')}
            </Link>
            <Link
              to={`/projects/${project.id}/risks`}
              className="text-xs text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {t('risk.navShort')}
            </Link>
            {project.correspondenceEnabled && (
              <Link
                to={`/projects/${project.id}/correspondence`}
                className="text-xs text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {t('correspondence.navShort')}
              </Link>
            )}
          </div>
        </div>
      </div>
      {(hasBudget || canManage) && (
        <div className="mt-2 ms-7 text-xs text-text flex items-center gap-2 flex-wrap">
          <span className="font-medium">{t('projects.budget.label')}:</span>
          <span dir="ltr" className="inline-block">
            {t('projects.budget.planned')} <code>{fmt(project.plannedBudget)}</code>
          </span>
        </div>
      )}
    </li>
  );
}
