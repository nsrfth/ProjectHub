import { useState } from 'react';
import Modal from '@/features/ui/Modal';
import Button from '@/features/ui/Button';
import { useT } from '@/lib/i18n';
import type { StatusCommentReason } from './statusComment';

export interface StatusCommentDialogProps {
  reason: StatusCommentReason;
  taskTitle: string;
  busy?: boolean;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}

/**
 * v2.5.58: mandatory-comment prompt for gated status changes (ON_HOLD / DONE).
 * The comment is stored as a real task comment in the same transaction as the
 * status change, so cancelling here leaves the task untouched.
 */
export default function StatusCommentDialog({
  reason,
  taskTitle,
  busy = false,
  onConfirm,
  onCancel,
}: StatusCommentDialogProps): JSX.Element {
  const t = useT();
  const [comment, setComment] = useState('');
  const trimmed = comment.trim();
  const isHold = reason === 'ON_HOLD';

  return (
    <Modal
      title={isHold ? t('tasks.statusComment.titleHold') : t('tasks.statusComment.titleDone')}
      onClose={onCancel}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !busy) onConfirm(trimmed);
        }}
        className="flex flex-col gap-3"
      >
        <p className="text-sm text-text-muted">
          {isHold ? t('tasks.statusComment.hintHold') : t('tasks.statusComment.hintDone')}
        </p>
        <p className="text-sm font-medium text-text truncate" title={taskTitle}>
          {taskTitle}
        </p>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t('tasks.statusComment.placeholder')}
          rows={4}
          maxLength={10_000}
          className="input resize-y"
          aria-label={t('tasks.statusComment.placeholder')}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('tasks.statusComment.cancel')}
          </Button>
          <Button type="submit" disabled={!trimmed || busy}>
            {t('tasks.statusComment.confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
