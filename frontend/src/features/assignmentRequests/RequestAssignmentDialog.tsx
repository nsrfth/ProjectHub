import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Modal from '@/features/ui/Modal';
import Button from '@/features/ui/Button';
import { useT } from '@/lib/i18n';
import { createAssignmentRequest } from './api';

interface RequestAssignmentDialogProps {
  teamId: string;
  projectId: string;
  taskId: string;
  /** The person the requester tried to assign (becomes the advisory proposedId). */
  proposedId: string;
  proposedName: string;
  onClose: () => void;
}

/**
 * v-next (P2): opened when a direct assign is rejected with
 * ASSIGNMENT_REQUEST_REQUIRED. Files the request; the target unit's manager
 * (or the division deputy) then decides who is assigned.
 */
export default function RequestAssignmentDialog({
  teamId,
  projectId,
  taskId,
  proposedId,
  proposedName,
  onClose,
}: RequestAssignmentDialogProps): JSX.Element {
  const t = useT();
  const [done, setDone] = useState(false);

  const mut = useMutation({
    mutationFn: () => createAssignmentRequest(teamId, projectId, taskId, proposedId),
    onSuccess: () => setDone(true),
  });

  return (
    <Modal title={t('assignments.request.title')} onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p className="text-sm">{t('assignments.request.done')}</p>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('assignments.request.close')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {t('assignments.request.body')} <span className="font-medium">{proposedName}</span>
          </p>
          <p className="text-xs text-text-muted">{t('assignments.request.explain')}</p>
          {mut.isError && <p className="text-xs text-danger">{t('assignments.request.error')}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={mut.isPending}>
              {t('assignments.request.cancel')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => mut.mutate()} disabled={mut.isPending}>
              {t('assignments.request.submit')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
