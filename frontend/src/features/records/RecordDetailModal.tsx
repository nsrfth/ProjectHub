import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '@/features/ui/Modal';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { formatShamsiTimestamp } from '@/lib/shamsi';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { useT } from '@/lib/i18n';
import * as recApi from './api';

interface RecordDetailModalProps {
  teamId: string;
  projectId: string;
  record: recApi.PmisRecord;
  statuses: string[];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}

// v1.90 (PMIS R8 GUI completion): edit a record's core fields and read/append
// its discussion thread. Field editing requires project write (canManage);
// commenting only needs project access, so the comment form is always shown.
export function RecordDetailModal({
  teamId,
  projectId,
  record,
  statuses,
  canManage,
  onClose,
  onSaved,
}: RecordDetailModalProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const [title, setTitle] = useState(record.title);
  const [description, setDescription] = useState(record.description ?? '');
  const [status, setStatus] = useState(record.status);
  const [assigneeId, setAssigneeId] = useState(record.assigneeId ?? '');
  const [dueDate, setDueDate] = useState<string | null>(record.dueDate);
  const [commentBody, setCommentBody] = useState('');

  const { data: members = [] } = useQuery({
    queryKey: ['team-members-assignees', teamId],
    queryFn: () => listTeamMembersForAssignees(teamId),
    enabled: canManage && !!teamId,
  });

  const { data: comments = [], isLoading: commentsLoading } = useQuery({
    queryKey: ['record-comments', teamId, projectId, record.id],
    queryFn: () => recApi.listRecordComments(teamId, projectId, record.id),
    enabled: !!record.id,
  });

  const saveMut = useMutation({
    mutationFn: () =>
      recApi.updateRecord(teamId, projectId, record.id, {
        title: title.trim(),
        description: description.trim() || null,
        status,
        assigneeId: assigneeId || null,
        dueDate,
      }),
    onSuccess: onSaved,
  });

  const commentMut = useMutation({
    mutationFn: () => recApi.createRecordComment(teamId, projectId, record.id, commentBody.trim()),
    onSuccess: () => {
      setCommentBody('');
      void qc.invalidateQueries({ queryKey: ['record-comments', teamId, projectId, record.id] });
    },
  });

  function submitSave(e: FormEvent): void {
    e.preventDefault();
    if (title.trim()) saveMut.mutate();
  }

  function submitComment(e: FormEvent): void {
    e.preventDefault();
    if (commentBody.trim()) commentMut.mutate();
  }

  return (
    <Modal title={`${record.reference} · ${record.recordTypeName}`} onClose={onClose}>
      <div className="space-y-5">
        <form onSubmit={submitSave} className="space-y-3">
          <label className="block text-sm">
            <span className="text-text-muted">{t('records.form.title')}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canManage}
              required
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm disabled:opacity-60"
            />
          </label>
          <label className="block text-sm">
            <span className="text-text-muted">{t('records.form.description')}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canManage}
              rows={3}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm disabled:opacity-60"
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-text-muted">{t('records.col.status')}</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={!canManage}
                className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm disabled:opacity-60"
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-text-muted">{t('records.col.assignee')}</span>
              <select
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                disabled={!canManage}
                className="mt-1 w-full rounded border border-border bg-surface px-2 py-2 text-sm disabled:opacity-60"
              >
                <option value="">—</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-text-muted">{t('records.form.dueDate')}</span>
            <div className="mt-1">
              <ShamsiDatePicker value={dueDate} onChange={setDueDate} disabled={!canManage} />
            </div>
          </label>
          {saveMut.isError && <p className="text-sm text-rose-600">{t('records.saveError')}</p>}
          {canManage && (
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!title.trim() || saveMut.isPending}
                className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            </div>
          )}
        </form>

        <div className="border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-semibold">{t('records.comments.title')}</h3>
          {commentsLoading ? (
            <p className="text-sm text-text-muted">{t('common.loading')}</p>
          ) : comments.length === 0 ? (
            <p className="text-sm text-text-muted italic">{t('records.comments.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li key={c.id} className="rounded border border-border bg-bg-elevated px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
                    <span className="font-medium">{c.authorName ?? '—'}</span>
                    <span dir="ltr">{formatShamsiTimestamp(c.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitComment} className="mt-3 space-y-2">
            <textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder={t('records.comments.placeholder')}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
            />
            {commentMut.isError && (
              <p className="text-sm text-rose-600">{t('records.comments.error')}</p>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!commentBody.trim() || commentMut.isPending}
                className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
              >
                {t('records.comments.add')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Modal>
  );
}
