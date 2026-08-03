import { Link } from 'react-router-dom';
import type { ProjectCrossTeam, ProjectStatus, RagStatus } from './api';
import {
  projectProgress,
  sortProjectsForDashboard,
  summarizeProjects,
} from './projectDashboard';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

interface ProjectsDashboardProps {
  projects: ProjectCrossTeam[];
  onOpenProject: (projectId: string) => void;
}

const STATUS_TONE: Record<ProjectStatus, string> = {
  ACTIVE: 'bg-success/15 text-success',
  ON_HOLD: 'bg-warning/15 text-warning',
  ARCHIVED: 'bg-bg-elevated text-text-muted',
};

const HEALTH_TONE: Record<RagStatus, { dot: string; text: string }> = {
  GREEN: { dot: 'bg-success', text: 'text-success' },
  AMBER: { dot: 'bg-warning', text: 'text-warning' },
  RED: { dot: 'bg-danger', text: 'text-danger' },
};

export default function ProjectsDashboard({
  projects,
  onOpenProject,
}: ProjectsDashboardProps): JSX.Element {
  const t = useT();
  const summary = summarizeProjects(projects);
  const sortedProjects = sortProjectsForDashboard(projects);

  if (projects.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <DashboardIcon />
        </div>
        <h2 className="font-semibold text-text">{t('projects.dashboard.emptyTitle')}</h2>
        <p className="mt-1 text-sm text-text-muted">{t('projects.dashboard.emptyBody')}</p>
      </section>
    );
  }

  return (
    <div className="space-y-4" data-testid="projects-dashboard">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label={t('projects.dashboard.total')}
          value={summary.total}
          detail={t('projects.dashboard.totalDetail')}
          tone="primary"
        />
        <MetricCard
          label={t('projects.dashboard.active')}
          value={summary.active}
          detail={t('projects.dashboard.activeDetail')}
          tone="success"
        />
        <MetricCard
          label={t('projects.dashboard.atRisk')}
          value={summary.atRisk}
          detail={t('projects.dashboard.atRiskDetail')}
          tone={summary.atRisk > 0 ? 'danger' : 'neutral'}
        />
        <MetricCard
          label={t('projects.dashboard.avgProgress')}
          value={`${summary.averageProgress}%`}
          detail={t('projects.dashboard.avgProgressDetail')}
          tone="neutral"
          progress={summary.averageProgress}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <DashboardPanel title={t('projects.dashboard.health')}>
          <DistributionRows
            rows={[
              {
                label: t('projects.status.rag.green'),
                value: summary.byHealth.GREEN,
                color: 'bg-success',
              },
              {
                label: t('projects.status.rag.amber'),
                value: summary.byHealth.AMBER,
                color: 'bg-warning',
              },
              {
                label: t('projects.status.rag.red'),
                value: summary.byHealth.RED,
                color: 'bg-danger',
              },
            ]}
            total={summary.total}
          />
        </DashboardPanel>

        <DashboardPanel title={t('projects.dashboard.status')}>
          <DistributionRows
            rows={[
              {
                label: t('projects.status.active'),
                value: summary.byStatus.ACTIVE,
                color: 'bg-primary',
              },
              {
                label: t('projects.status.onHold'),
                value: summary.byStatus.ON_HOLD,
                color: 'bg-warning',
              },
              {
                label: t('projects.status.archived'),
                value: summary.byStatus.ARCHIVED,
                color: 'bg-text-muted',
              },
            ]}
            total={summary.total}
          />
        </DashboardPanel>

        <DashboardPanel title={t('projects.dashboard.schedule')}>
          <div className="grid grid-cols-2 gap-3">
            <ScheduleSignal
              label={t('projects.dashboard.overdue')}
              value={summary.overdue}
              tone={summary.overdue > 0 ? 'danger' : 'neutral'}
            />
            <ScheduleSignal
              label={t('projects.dashboard.endingSoon')}
              value={summary.endingSoon}
              tone={summary.endingSoon > 0 ? 'warning' : 'neutral'}
            />
          </div>
          <p className="mt-3 text-xs leading-5 text-text-muted">
            {t('projects.dashboard.scheduleHint')}
          </p>
        </DashboardPanel>
      </section>

      <section className="rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-semibold text-text">{t('projects.dashboard.overview')}</h2>
            <p className="text-xs text-text-muted">{t('projects.dashboard.overviewHint')}</p>
          </div>
          <span className="text-xs text-text-muted">
            {t('projects.dashboard.filteredCount').replace('{n}', String(projects.length))}
          </span>
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-2 2xl:grid-cols-3">
          {sortedProjects.map((project) => (
            <ProjectDashboardCard
              key={project.id}
              project={project}
              onOpen={() => onOpenProject(project.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
  progress,
}: {
  label: string;
  value: number | string;
  detail: string;
  tone: 'primary' | 'success' | 'danger' | 'neutral';
  progress?: number;
}): JSX.Element {
  const toneClass = {
    primary: 'border-primary/30 bg-primary/5',
    success: 'border-success/30 bg-success/5',
    danger: 'border-danger/30 bg-danger/5',
    neutral: 'border-border bg-surface',
  }[tone];
  const valueClass = {
    primary: 'text-primary',
    success: 'text-success',
    danger: 'text-danger',
    neutral: 'text-text',
  }[tone];

  return (
    <article className={`min-w-0 rounded-xl border p-4 ${toneClass}`}>
      <p className="truncate text-xs font-medium text-text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {progress === undefined ? (
        <p className="mt-1 truncate text-[11px] text-text-muted">{detail}</p>
      ) : (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 truncate text-[11px] text-text-muted">{detail}</p>
        </div>
      )}
    </article>
  );
}

function DashboardPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

function DistributionRows({
  rows,
  total,
}: {
  rows: Array<{ label: string; value: number; color: string }>;
  total: number;
}): JSX.Element {
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const width = total ? Math.round((row.value / total) * 100) : 0;
        return (
          <div key={row.label}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="text-text-muted">{row.label}</span>
              <span className="font-medium tabular-nums text-text">
                {row.value} <span className="font-normal text-text-muted">· {width}%</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated">
              <div className={`h-full rounded-full ${row.color}`} style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScheduleSignal({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'danger' | 'warning' | 'neutral';
}): JSX.Element {
  const classes = {
    danger: 'bg-danger/10 text-danger',
    warning: 'bg-warning/10 text-warning',
    neutral: 'bg-bg-elevated text-text',
  }[tone];
  return (
    <div className={`rounded-lg p-3 ${classes}`}>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs">{label}</p>
    </div>
  );
}

function ProjectDashboardCard({
  project,
  onOpen,
}: {
  project: ProjectCrossTeam;
  onOpen: () => void;
}): JSX.Element {
  const t = useT();
  const progress = projectProgress(project);
  const health = project.ragStatus ?? 'GREEN';
  const healthTone = HEALTH_TONE[health];
  const statusLabel = t(
    `projects.status.${project.status === 'ON_HOLD' ? 'onHold' : project.status.toLowerCase()}`,
  );
  const healthLabel = t(`projects.status.rag.${health.toLowerCase()}`);

  return (
    <article className="group rounded-lg border border-border bg-bg/40 p-4 transition hover:border-primary/40 hover:bg-primary/[0.025]">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onOpen} className="min-w-0 text-start">
          <span className="block truncate font-semibold text-text group-hover:text-primary">
            {project.name}
          </span>
          <span className="mt-0.5 block truncate text-xs text-text-muted">
            {[project.code, project.teamName].filter(Boolean).join(' · ')}
          </span>
        </button>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${STATUS_TONE[project.status]}`}>
          {statusLabel}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs">
        <span className={`inline-flex items-center gap-1.5 font-medium ${healthTone.text}`}>
          <span className={`h-2 w-2 rounded-full ${healthTone.dot}`} />
          {healthLabel}
        </span>
        <span className="font-semibold tabular-nums text-text">{progress}%</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className={`h-full rounded-full ${health === 'RED' ? 'bg-danger' : health === 'AMBER' ? 'bg-warning' : 'bg-primary'}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="min-w-0">
          <span className="block text-[10px] uppercase tracking-wide text-text-muted">
            {t('projects.dashboard.schedule')}
          </span>
          <span className="block truncate text-text" dir="auto">
            {formatShamsiCalendarDate(project.endDate) ?? '—'}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-[10px] uppercase tracking-wide text-text-muted">
            {t('projects.dashboard.organization')}
          </span>
          <span className="block truncate text-text">
            {project.orgUnit?.name ?? project.department?.name ?? '—'}
          </span>
        </div>
      </div>

      {project.ragReason && health !== 'GREEN' && (
        <p className="mt-3 line-clamp-2 rounded bg-bg-elevated px-2 py-1.5 text-xs text-text-muted">
          {project.ragReason}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3 text-xs">
        <button type="button" onClick={onOpen} className="font-medium text-primary hover:underline">
          {t('projects.dashboard.openTasks')}
        </button>
        <Link to={`/projects/${project.id}/reports/status`} className="text-text-muted hover:text-primary">
          {t('projects.dashboard.statusReport')}
        </Link>
        <Link to={`/projects/${project.id}/reports/gantt`} className="text-text-muted hover:text-primary">
          Gantt
        </Link>
      </div>
    </article>
  );
}

function DashboardIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="4" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
