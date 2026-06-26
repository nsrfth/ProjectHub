import { useState } from 'react';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';
import type { RagStatus } from '@/features/projects/api';

interface ProjectHealthModalProps {
  projectName: string;
  currentStatus: RagStatus;
  currentReason: string | null;
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (ragStatus: RagStatus, ragReason: string | null) => void;
}

const RAG_OPTIONS: { value: RagStatus; emoji: string; labelKey: string }[] = [
  { value: 'GREEN', emoji: '🟢', labelKey: 'projects.health.green' },
  { value: 'AMBER', emoji: '🟡', labelKey: 'projects.health.amber' },
  { value: 'RED', emoji: '🔴', labelKey: 'projects.health.red' },
];

export default function ProjectHealthModal({
  projectName,
  currentStatus,
  currentReason,
  pending,
  error,
  onClose,
  onSave,
}: ProjectHealthModalProps): JSX.Element {
  const t = useT();
  const [status, setStatus] = useState<RagStatus>(currentStatus);
  const [reason, setReason] = useState(currentReason ?? '');

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    onSave(status, reason.trim() || null);
  }

  return (
    <Modal title={t('projects.health.title')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-text-muted">{projectName}</p>
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('projects.health.status')}</legend>
          {RAG_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="ragStatus"
                value={opt.value}
                checked={status === opt.value}
                onChange={() => setStatus(opt.value)}
              />
              <span>
                {opt.emoji} {t(opt.labelKey as never)}
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          <span>{t('projects.health.reason')}</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={t('projects.health.reasonPlaceholder')}
            className="rounded border px-2 py-1.5 dark:bg-slate-700 resize-y"
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border">
            {t('projects.edit.cancel')}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
          >
            {t('projects.health.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
