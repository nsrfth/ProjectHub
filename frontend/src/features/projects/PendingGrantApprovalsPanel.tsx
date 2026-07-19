import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import * as grantsApi from '@/features/projects/grantsApi';
import Button from '@/features/ui/Button';

/**
 * v2.8 (Phase 3): grants awaiting MY approval — as a unit manager (unit
 * participation) or a target-team manager (cross-team share). Mounted in the
 * notification bell dropdown beside GroupInvitesPanel, which is where users
 * already look for things that need their answer.
 */
export default function PendingGrantApprovalsPanel(): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();

  const key = ['grant-approvals'];
  const { data: items = [] } = useQuery({
    queryKey: key,
    queryFn: grantsApi.listMyApprovals,
    // Same cadence as the bell's own polling — this is a pull-based inbox.
    refetchInterval: 60_000,
  });

  const decideMut = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'accept' | 'decline' }) =>
      grantsApi.decideGrant(id, decision),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
      // An acceptance changes which projects this user's people can see.
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['notifications', 'count'] });
    },
  });

  if (items.length === 0) return null;

  return (
    <div className="border-t border-border pt-2 mt-2" data-testid="grant-approvals-panel">
      <h4 className="text-xs font-semibold text-text-muted px-3 pb-1">
        {t('grants.approvals.title')}
      </h4>
      <ul className="space-y-1 px-3 pb-2">
        {items.map((g) => (
          <li key={g.id} className="text-sm" data-testid="grant-approval-row">
            <div className="truncate">
              <span className="font-medium">{g.projectName}</span>{' '}
              <span className="text-xs text-text-muted">
                ({g.teamName} · {g.level === 'WRITE' ? t('grants.level.write') : t('grants.level.read')}
                {' → '}
                {g.subjectName})
              </span>
            </div>
            <div className="flex gap-2 mt-0.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={decideMut.isPending}
                onClick={() => decideMut.mutate({ id: g.id, decision: 'accept' })}
              >
                {t('grants.approvals.accept')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={decideMut.isPending}
                onClick={() => decideMut.mutate({ id: g.id, decision: 'decline' })}
              >
                {t('grants.approvals.decline')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
