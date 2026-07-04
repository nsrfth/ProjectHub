import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as portfolioApi from '@/features/portfolio/api';
import type { OrgUnitTreeNode } from '@/features/portfolio/api';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

// v2.5.27: distinct badge colour per org-unit type (COMPANY = amber).
const TYPE_BADGE: Record<string, string> = {
  HOLDING: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  COMPANY: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  PORTFOLIO: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  PROGRAM: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
};

function TypeBadge({ type, label }: { type: string; label: string }): JSX.Element {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
        TYPE_BADGE[type] ?? TYPE_BADGE.HOLDING
      }`}
    >
      {label}
    </span>
  );
}

function flattenTree(nodes: OrgUnitTreeNode[], depth = 0): Array<{ node: OrgUnitTreeNode; depth: number }> {
  const out: Array<{ node: OrgUnitTreeNode; depth: number }> = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    out.push(...flattenTree(n.children, depth + 1));
  }
  return out;
}

export default function PortfolioPage(): JSX.Element {
  const { user } = useAuth();
  const { teams } = useTeams();
  const t = useT();
  const qc = useQueryClient();

  const canView =
    user?.globalRole === 'ADMIN' || teams.some((tm) => tm.myRole === 'MANAGER');
  const canManage = canView;

  const { data: tree = [] } = useQuery({
    queryKey: ['portfolio', 'tree'],
    queryFn: portfolioApi.listOrgUnitTree,
    enabled: canView,
  });

  const flat = useMemo(() => flattenTree(tree), [tree]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = flat.find((x) => x.node.id === selectedId)?.node ?? null;

  const [parentId, setParentId] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState<'COMPANY' | 'PORTFOLIO' | 'PROGRAM'>('PORTFOLIO');

  const createMut = useMutation({
    mutationFn: () =>
      portfolioApi.createOrgUnit({
        parentId: parentId || null,
        type,
        name: name.trim(),
        code: code.trim(),
      }),
    onSuccess: async (created) => {
      setName('');
      setCode('');
      await qc.invalidateQueries({ queryKey: ['portfolio'] });
      setSelectedId(created.id);
    },
  });

  const { data: summary } = useQuery({
    queryKey: ['portfolio', selectedId, 'summary'],
    queryFn: () => portfolioApi.getPortfolioSummary(selectedId!),
    enabled: !!selectedId && canView,
  });
  const { data: progress } = useQuery({
    queryKey: ['portfolio', selectedId, 'progress'],
    queryFn: () => portfolioApi.getPortfolioProgress(selectedId!),
    enabled: !!selectedId && canView,
  });
  const { data: rag } = useQuery({
    queryKey: ['portfolio', selectedId, 'rag'],
    queryFn: () => portfolioApi.getPortfolioRag(selectedId!),
    enabled: !!selectedId && canView,
  });
  const { data: cost } = useQuery({
    queryKey: ['portfolio', selectedId, 'cost'],
    queryFn: () => portfolioApi.getPortfolioCost(selectedId!),
    enabled: !!selectedId && canView,
  });

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    if (!name.trim() || !code.trim()) return;
    createMut.mutate();
  }

  if (!canView) {
    return <p className="text-sm text-text-muted p-8">{t('portfolio.noAccess')}</p>;
  }

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold mb-1">{t('portfolio.title')}</h1>
      <p className="text-sm text-text-muted mb-6">{t('portfolio.subtitle')}</p>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <section className="bg-surface rounded shadow p-3">
          <h2 className="text-xs font-semibold uppercase text-text-muted mb-2">
            {t('portfolio.tree')}
          </h2>
          <ul className="space-y-1">
            {flat.map(({ node, depth }) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(node.id)}
                  className={`block w-full text-start rounded px-2 py-1 text-sm ${
                    selectedId === node.id ? 'bg-bg-elevated font-medium' : 'hover:bg-bg-elevated'
                  }`}
                  style={{ paddingInlineStart: `${8 + depth * 12}px` }}
                >
                  {node.name} <TypeBadge type={node.type} label={t(`portfolio.type.${node.type}`)} />
                </button>
              </li>
            ))}
          </ul>

          {canManage && (
            <form onSubmit={onCreate} className="mt-4 space-y-2 border-t border-border pt-3">
              <h3 className="text-xs font-semibold uppercase text-text-muted">
                {t('portfolio.create')}
              </h3>
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
              >
                <option value="">{t('portfolio.rootParent')}</option>
                {flat.map(({ node }) => (
                  <option key={node.id} value={node.id}>
                    {node.name} ({t(`portfolio.type.${node.type}`)})
                  </option>
                ))}
              </select>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as 'COMPANY' | 'PORTFOLIO' | 'PROGRAM')}
                className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
              >
                <option value="COMPANY">COMPANY</option>
                <option value="PORTFOLIO">PORTFOLIO</option>
                <option value="PROGRAM">PROGRAM</option>
              </select>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('portfolio.name')}
                className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
              />
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder={t('portfolio.code')}
                className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
              />
              <button
                type="submit"
                disabled={createMut.isPending || !name.trim() || !code.trim()}
                className="w-full text-sm rounded bg-slate-900 text-white px-3 py-1.5 disabled:opacity-50"
              >
                {t('portfolio.add')}
              </button>
              {createMut.isError && (
                <p className="text-xs text-danger">{errorMessage(createMut.error, 'Failed')}</p>
              )}
            </form>
          )}
        </section>

        <section className="bg-surface rounded shadow p-4">
          {!selected && (
            <p className="text-sm text-text-muted">{t('portfolio.selectNode')}</p>
          )}
          {selected && (
            <>
              <h2 className="font-medium text-lg">{selected.name}</h2>
              <p className="text-xs text-text-muted mb-4">
                {selected.code} · {t(`portfolio.type.${selected.type}`)} · {selected.projectCount}{' '}
                {t('portfolio.projects')}
              </p>

              {summary && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4 text-sm">
                  <div className="rounded border border-border p-2">
                    <div className="text-text-muted text-xs">{t('portfolio.active')}</div>
                    <div className="font-semibold">{summary.activeCount}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-text-muted text-xs">{t('portfolio.openTasks')}</div>
                    <div className="font-semibold">{summary.openTaskCount}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-text-muted text-xs">{t('portfolio.overdue')}</div>
                    <div className="font-semibold">{summary.overdueTaskCount}</div>
                  </div>
                </div>
              )}

              {rag && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium mb-1">{t('portfolio.rag')}</h3>
                  <p className="text-xs text-text-muted">
                    {t('portfolio.ragCounts')
                      .replace('{g}', String(rag.byStatus.GREEN))
                      .replace('{a}', String(rag.byStatus.AMBER))
                      .replace('{r}', String(rag.byStatus.RED))}
                  </p>
                </div>
              )}

              {cost && cost.rollupByCurrency.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium mb-1">{t('portfolio.cost')}</h3>
                  <ul className="text-xs space-y-1">
                    {cost.rollupByCurrency.map((row) => (
                      <li key={row.currency}>
                        {row.currency}: {row.totalPlanned ?? '—'} ({row.projectCount}{' '}
                        {t('portfolio.projects')})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {progress && progress.projects.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-1">
                    {t('portfolio.progress')} ({progress.avgPercentComplete}%)
                  </h3>
                  <table className="w-full text-sm">
                    <tbody>
                      {progress.projects.map((p) => (
                        <tr key={p.projectId} className="border-t border-border">
                          <td className="py-1">{p.projectName}</td>
                          <td className="py-1 text-text-muted text-xs">{p.teamName}</td>
                          <td className="py-1 text-end">{p.percentComplete}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
