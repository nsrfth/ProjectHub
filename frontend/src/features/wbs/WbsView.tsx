import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useT } from '@/lib/i18n';
import Modal from '@/features/ui/Modal';
import * as tasksApi from '@/features/tasks/api';
import * as wbsApi from './api';
import type { WbsNode } from './api';

interface Props {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

// v1.90 (PMIS R1 GUI): the project Work Breakdown Structure. Reads the flat DFS
// tree from GET /wbs and renders it indented by depth with outline codes and
// rollup %; managers can add child/root tasks and reparent nodes (POST /move).
export function WbsView({ teamId, projectId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [addParent, setAddParent] = useState<{ id: string | null; title: string } | null>(null);
  const [moving, setMoving] = useState<WbsNode | null>(null);

  const { data: nodes = [], isLoading } = useQuery({
    queryKey: ['wbs', teamId, projectId],
    queryFn: () => wbsApi.getWbs(teamId, projectId),
    enabled: !!teamId && !!projectId,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['wbs', teamId, projectId] });
    void qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
  };

  if (isLoading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">{t('wbs.hint')}</p>
        {canManage && (
          <button
            type="button"
            onClick={() => setAddParent({ id: null, title: t('wbs.root') })}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
          >
            {t('wbs.addRoot')}
          </button>
        )}
      </div>

      {nodes.length === 0 ? (
        <p className="text-sm text-slate-500 italic">{t('wbs.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-muted">
              <tr>
                <Th className="w-16">{t('wbs.col.code')}</Th>
                <Th>{t('wbs.col.title')}</Th>
                <Th className="w-28">{t('wbs.col.progress')}</Th>
                <Th>{t('wbs.col.responsible')}</Th>
                {canManage && <Th>{''}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {nodes.map((n) => (
                <tr key={n.id} className="hover:bg-bg-elevated">
                  <td className="px-3 py-2 font-mono text-xs text-text-muted" dir="ltr">{n.wbsCode}</td>
                  <td className="px-3 py-2">
                    <span style={{ paddingInlineStart: `${n.wbsDepth * 1.25}rem` }} className="flex items-center gap-2">
                      {n.isSummary && <span className="text-text-muted">▾</span>}
                      <Link
                        to={`/projects/${projectId}/tasks/${n.id}`}
                        className={`hover:underline ${n.isSummary ? 'font-medium' : ''}`}
                      >
                        {n.title}
                      </Link>
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <ProgressBar
                      pct={n.isSummary ? n.rollupPercentComplete : n.percentComplete}
                      summary={n.isSummary}
                    />
                  </td>
                  <td className="px-3 py-2 truncate text-xs">{n.responsibleName ?? '—'}</td>
                  {canManage && (
                    <td className="px-3 py-2 text-end whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setAddParent({ id: n.id, title: n.title })}
                        className="text-xs text-primary hover:underline me-3"
                      >
                        {t('wbs.addChild')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMoving(n)}
                        className="text-xs text-primary hover:underline"
                      >
                        {t('wbs.move')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addParent && (
        <AddTaskModal
          teamId={teamId}
          projectId={projectId}
          parentId={addParent.id}
          parentTitle={addParent.title}
          onClose={() => setAddParent(null)}
          onCreated={() => { setAddParent(null); invalidate(); }}
        />
      )}

      {moving && (
        <MoveTaskModal
          teamId={teamId}
          projectId={projectId}
          node={moving}
          nodes={nodes}
          onClose={() => setMoving(null)}
          onMoved={() => { setMoving(null); invalidate(); }}
        />
      )}
    </div>
  );
}

function ProgressBar({ pct, summary }: { pct: number; summary: boolean }): JSX.Element {
  return (
    <span className="flex items-center gap-2" dir="ltr">
      <span className="h-1.5 w-16 rounded-full bg-bg-elevated overflow-hidden">
        <span
          className={`block h-full ${summary ? 'bg-primary/70' : 'bg-primary'}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </span>
      <span className="text-xs tabular-nums text-text-muted">{pct}%</span>
    </span>
  );
}

interface AddTaskModalProps {
  teamId: string;
  projectId: string;
  parentId: string | null;
  parentTitle: string;
  onClose: () => void;
  onCreated: () => void;
}

function AddTaskModal({ teamId, projectId, parentId, parentTitle, onClose, onCreated }: AddTaskModalProps): JSX.Element {
  const t = useT();
  const [title, setTitle] = useState('');

  const createMut = useMutation({
    mutationFn: () => tasksApi.createTask(teamId, projectId, { title: title.trim(), parentId }),
    onSuccess: onCreated,
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (title.trim()) createMut.mutate();
  }

  return (
    <Modal title={parentId ? t('wbs.addChildTo').replace('{parent}', parentTitle) : t('wbs.addRoot')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="text-text-muted">{t('wbs.form.title')}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        {createMut.isError && <p className="text-sm text-rose-600">{t('wbs.createError')}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm text-text-muted hover:bg-bg-elevated">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!title.trim() || createMut.isPending}
            className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
          >
            {t('wbs.form.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface MoveTaskModalProps {
  teamId: string;
  projectId: string;
  node: WbsNode;
  nodes: WbsNode[];
  onClose: () => void;
  onMoved: () => void;
}

function MoveTaskModal({ teamId, projectId, node, nodes, onClose, onMoved }: MoveTaskModalProps): JSX.Element {
  const t = useT();

  // Eligible parents = every node except the moving node and its descendants.
  const blocked = useMemo(() => {
    const childrenOf = new Map<string | null, WbsNode[]>();
    for (const n of nodes) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    }
    const set = new Set<string>([node.id]);
    const stack = [node.id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (!set.has(c.id)) { set.add(c.id); stack.push(c.id); }
      }
    }
    return set;
  }, [nodes, node.id]);

  const targets = nodes.filter((n) => !blocked.has(n.id));
  const [newParentId, setNewParentId] = useState<string>(node.parentId ?? '');
  const [position, setPosition] = useState('999');

  const moveMut = useMutation({
    mutationFn: () =>
      wbsApi.moveTask(teamId, projectId, node.id, newParentId || null, parseInt(position, 10) || 0),
    onSuccess: onMoved,
  });

  return (
    <Modal title={t('wbs.moveTitle').replace('{title}', node.title)} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); moveMut.mutate(); }} className="space-y-3">
        <label className="block text-sm">
          <span className="text-text-muted">{t('wbs.newParent')}</span>
          <select
            value={newParentId}
            onChange={(e) => setNewParentId(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm"
          >
            <option value="">{t('wbs.root')}</option>
            {targets.map((n) => (
              <option key={n.id} value={n.id}>
                {n.wbsCode} · {n.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">{t('wbs.position')}</span>
          <input
            type="number" min="0" dir="ltr"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-text-muted">{t('wbs.positionHint')}</span>
        </label>
        {moveMut.isError && <p className="text-sm text-rose-600">{t('wbs.moveError')}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm text-text-muted hover:bg-bg-elevated">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={moveMut.isPending}
            className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
          >
            {t('wbs.moveConfirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <th className={`px-3 py-2 text-start font-medium uppercase tracking-wide text-[11px] ${className ?? ''}`}>
      {children}
    </th>
  );
}
