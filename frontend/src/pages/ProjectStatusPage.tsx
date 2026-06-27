import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchProjectStatus } from '@/features/reports/projectStatusApi';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { budgetLocaleFromLanguage, formatBudget, type BudgetFormatLocale } from '@/lib/formatBudget';
import { getLanguage, useT } from '@/lib/i18n';

// v2.5.6: project status report — RAG health, code, description, risks,
// change requests, cost summary (all module-gated). Print-friendly.

interface RouteParams extends Record<string, string | undefined> {
  projectId: string;
}

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  ON_HOLD: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  ARCHIVED: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

const RAG_BADGE: Record<string, string> = {
  GREEN: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  AMBER: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  RED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const RAG_DOT: Record<string, string> = {
  GREEN: 'bg-green-500',
  AMBER: 'bg-amber-500',
  RED: 'bg-red-500',
};

export default function ProjectStatusPage(): JSX.Element {
  const { projectId } = useParams<RouteParams>();
  const t = useT();
  const locale = budgetLocaleFromLanguage(getLanguage());

  const { data: allProjects } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: async () => {
      const { api } = await import('@/lib/api');
      return (await api.get<Array<{ id: string; teamId: string; name: string }>>('/projects')).data;
    },
  });
  const teamId = allProjects?.find((p) => p.id === projectId)?.teamId ?? null;

  const { data, isLoading, error } = useQuery({
    queryKey: ['projectStatus', teamId, projectId],
    queryFn: () => fetchProjectStatus(teamId!, projectId!),
    enabled: !!teamId && !!projectId,
  });

  const statusLabel = data
    ? t(`projects.status.${data.status === 'ON_HOLD' ? 'onHold' : data.status.toLowerCase()}` as never)
    : '';

  const ragLabel = data ? t(`projects.status.rag.${data.ragStatus.toLowerCase()}` as never) : '';

  return (
    <div className="p-6 max-w-3xl mx-auto print:p-0 print:max-w-none">
      <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
        <Link to="/projects" className="text-sm text-slate-500 hover:underline">
          ← {t('nav.projects')}
        </Link>
        {data && (
          <button
            type="button"
            onClick={() => window.print()}
            className="text-sm rounded border border-border px-3 py-1.5 hover:bg-bg"
          >
            🖨 {t('projects.status.print')}
          </button>
        )}
      </div>

      {isLoading && <p className="text-sm text-slate-500">{t('common.loading')}</p>}
      {error && (
        <p className="text-sm text-danger" role="alert">{t('projects.status.loadError')}</p>
      )}

      {data && (
        <section className="bg-surface rounded shadow p-6 print:shadow-none print:bg-white space-y-6">

          {/* Header — name, code, status badges, RAG */}
          <header className="border-b border-border pb-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-slate-400">{t('projects.status.title')}</p>
                <h1 className="text-2xl font-semibold truncate">{data.name}</h1>
                {data.code && (
                  <p className="text-sm text-slate-400 mt-0.5 font-mono">{data.code}</p>
                )}
              </div>
              <div className="shrink-0 flex flex-col items-end gap-1.5">
                <span className={`text-xs font-medium rounded-full px-3 py-1 ${STATUS_BADGE[data.status] ?? ''}`}>
                  {statusLabel}
                </span>
                <span className={`flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1 ${RAG_BADGE[data.ragStatus] ?? ''}`}>
                  <span className={`inline-block w-2 h-2 rounded-full ${RAG_DOT[data.ragStatus] ?? ''}`} />
                  {ragLabel}
                </span>
              </div>
            </div>
            {data.ragReason && (
              <p className="text-sm text-text bg-bg-elevated rounded px-3 py-2">{data.ragReason}</p>
            )}
            {data.description && (
              <p className="text-sm text-slate-500">{data.description}</p>
            )}
          </header>

          {/* Progress */}
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-sm text-text">{t('projects.status.percentComplete')}</span>
              <span className="text-2xl font-bold tabular-nums">{data.percentComplete}%</span>
            </div>
            <div className="h-3 w-full rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full bg-success rounded-full transition-all"
                style={{ width: `${data.percentComplete}%` }}
              />
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {data.taskCounts.done} / {data.taskCounts.total} {t('projects.status.done').toLowerCase()}
            </p>
          </div>

          {/* Task counts by status */}
          <div>
            <p className="text-sm font-medium text-text mb-2">{t('projects.status.byStatus')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <Tile label={t('projects.status.todo')} value={data.taskCounts.todo} />
              <Tile label={t('projects.status.inProgress')} value={data.taskCounts.inProgress} />
              <Tile label={t('projects.status.review')} value={data.taskCounts.review} />
              <Tile label={t('projects.status.done')} value={data.taskCounts.done} />
              <Tile label={t('projects.status.total')} value={data.taskCounts.total} emphasis />
            </div>
            <div className="mt-3">
              <span
                className={`inline-flex items-center gap-2 text-sm rounded px-3 py-1.5 ${
                  data.overdueCount > 0
                    ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200 font-medium'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                }`}
              >
                {t('projects.status.overdue')}: <strong className="tabular-nums">{data.overdueCount}</strong>
              </span>
            </div>
          </div>

          {/* Schedule + budget + people */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
            <Field label={t('projects.status.dates')}>
              <span dir="auto">
                {formatShamsiCalendarDate(data.startDate) ?? '—'}
                {' → '}
                {formatShamsiCalendarDate(data.endDate) ?? '—'}
              </span>
            </Field>
            <Field label={t('projects.status.budget')}>
              <span dir="ltr">
                {data.plannedBudget ? formatBudget(data.plannedBudget, data.budgetCurrency, locale) : '—'}
              </span>
            </Field>
            <Field label={t('projects.status.owner')}>{data.ownerName ?? '—'}</Field>
            <Field label={t('projects.accountable')}>{data.accountableName ?? '—'}</Field>
          </div>

          {/* Risks — module-gated */}
          {data.risks !== null && (
            <div>
              <p className="text-sm font-medium text-text mb-2">{t('projects.status.risks')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Tile label={t('projects.status.risksOpen')} value={data.risks.open} danger={data.risks.open > 0} />
                <Tile label={t('projects.status.risksTotal')} value={data.risks.total} />
              </div>
            </div>
          )}

          {/* Change requests — module-gated */}
          {data.changeRequests !== null && (
            <div>
              <p className="text-sm font-medium text-text mb-2">{t('projects.status.changeRequests')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Tile label={t('projects.status.crPending')} value={data.changeRequests.pending} danger={data.changeRequests.pending > 0} />
                <Tile label={t('projects.status.crApproved')} value={data.changeRequests.approved} />
                <Tile label={t('projects.status.total')} value={data.changeRequests.total} emphasis />
              </div>
            </div>
          )}

          {/* Cost summary — module-gated */}
          {data.costSummary !== null && (
            <div>
              <p className="text-sm font-medium text-text mb-2">
                {t('projects.status.costSummary')}
                {' '}
                <span className="font-normal text-slate-400">({data.costSummary.currency})</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <CostTile
                  label={t('projects.status.costPlanned')}
                  value={data.costSummary.plannedBudgetLines}
                  currency={data.costSummary.currency}
                  locale={locale}
                />
                <CostTile
                  label={t('projects.status.costCommitted')}
                  value={data.costSummary.committed}
                  currency={data.costSummary.currency}
                  locale={locale}
                />
                <CostTile
                  label={t('projects.status.costActual')}
                  value={data.costSummary.actual}
                  currency={data.costSummary.currency}
                  locale={locale}
                />
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  emphasis = false,
  danger = false,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <div
      className={`rounded border px-3 py-2 text-center ${
        danger
          ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950'
          : emphasis
          ? 'border-border bg-bg'
          : 'border-border'
      }`}
    >
      <div className={`text-2xl font-semibold tabular-nums ${danger ? 'text-red-600 dark:text-red-400' : ''}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

function CostTile({
  label,
  value,
  currency,
  locale,
}: {
  label: string;
  value: string;
  currency: string;
  locale: BudgetFormatLocale;
}): JSX.Element {
  const formatted = formatBudget(value, currency as 'IRR' | 'EUR' | 'USD', locale);
  return (
    <div className="rounded border border-border px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">{label}</div>
      <div className="text-lg font-semibold tabular-nums" dir="ltr">{formatted}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-0.5">{label}</div>
      <div className="text-text">{children}</div>
    </div>
  );
}
