import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import * as assignmentApi from './api';
import Button from '@/features/ui/Button';

/**
 * v-next (P2): cross-unit assignment requests awaiting MY decision — as a
 * department manager (scenario B) or a division deputy / forwarded manager
 * (scenario C). Mounted in the notification bell beside PendingGrantApprovals-
 * Panel, the established home for "things that need your answer".
 *
 * v1 action set: confirm the requester's proposed assignee, or decline with a
 * reason. Overriding the assignee and forwarding (ابلاغ) to a department manager
 * are follow-ups that need a member picker.
 */
export default function PendingAssignmentApprovalsPanel(): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();
  const key = ['assignment-approvals'];

  const { data: items = [] } = useQuery({
    queryKey: key,
    queryFn: assignmentApi.listMyAssignmentApprovals,
    // Pull-based inbox, same cadence as the bell.
    refetchInterval: 60_000,
  });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ['notifications', 'count'] });
  };

  const assignMut = useMutation({
    mutationFn: ({ id, assigneeId }: { id: string; assigneeId: string }) =>
      assignmentApi.assignAssignmentRequest(id, assigneeId),
    onSuccess: invalidate,
  });
  const declineMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      assignmentApi.declineAssignmentRequest(id, reason),
    onSuccess: invalidate,
  });

  if (items.length === 0) return null;

  const pending = assignMut.isPending || declineMut.isPending;

  return (
    <div className="border-t border-border pt-2 mt-2" data-testid="assignment-approvals-panel">
      <h4 className="text-xs font-semibold text-text-muted px-3 pb-1">
        {t('assignments.approvals.title')}
      </h4>
      <ul className="space-y-1 px-3 pb-2">
        {items.map((r) => (
          <li key={r.id} className="text-sm" data-testid="assignment-approval-row">
            <div className="truncate">
              <span className="font-medium">{r.taskTitle}</span>{' '}
              <span className="text-xs text-text-muted">({r.projectName})</span>
            </div>
            <div className="text-xs text-text-muted truncate">
              {r.requesterName}
              {' → '}
              {r.proposedName ?? '—'}
            </div>
            <div className="text-xs text-text-muted mt-0.5">{t('assignments.approvals.exposure')}</div>
            <div className="flex gap-2 mt-0.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || !r.proposedId}
                onClick={() =>
                  r.proposedId && assignMut.mutate({ id: r.id, assigneeId: r.proposedId })
                }
              >
                {t('assignments.approvals.assign')}
                {r.proposedName ? ` ${r.proposedName}` : ''}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  const reason = window.prompt(t('assignments.approvals.declineReason'));
                  if (reason && reason.trim()) declineMut.mutate({ id: r.id, reason });
                }}
              >
                {t('assignments.approvals.decline')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
