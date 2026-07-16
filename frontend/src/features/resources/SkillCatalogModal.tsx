import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';
import * as api from './api';

interface Props {
  teamId: string;
  onClose: () => void;
}

// v1.90 (PMIS R6 GUI completion): team skill catalog CRUD. Deleting a skill the
// backend rejects (still attached to a resource) surfaces as an error message.
export function SkillCatalogModal({ teamId, onClose }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ['skills', teamId],
    queryFn: () => api.listSkills(teamId),
    enabled: !!teamId,
  });

  const invalidate = (): Promise<void> => qc.invalidateQueries({ queryKey: ['skills', teamId] });

  const createMut = useMutation({
    mutationFn: () => api.createSkill(teamId, name.trim()),
    onSuccess: () => { setName(''); void invalidate(); },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteSkill(teamId, id),
    onSuccess: invalidate,
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (name.trim()) createMut.mutate();
  }

  return (
    <Modal title={t('resources.skills.catalogTitle')} onClose={onClose}>
      <div className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-text-muted">{t('common.loading')}</p>
        ) : skills.length === 0 ? (
          <p className="text-sm text-text-muted">{t('resources.skills.empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {skills.map((s) => (
              <li key={s.id} className="flex items-center gap-1 rounded-full bg-bg-elevated px-2 py-1 text-sm">
                {s.name}
                <button
                  type="button"
                  disabled={deleteMut.isPending}
                  onClick={() => { if (window.confirm(t('resources.skills.deleteConfirm'))) deleteMut.mutate(s.id); }}
                  className="text-rose-600 hover:text-rose-700 disabled:opacity-50"
                  aria-label={t('common.delete')}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {deleteMut.isError && <p className="text-sm text-rose-600">{t('resources.skills.deleteError')}</p>}

        <form onSubmit={submit} className="flex items-end gap-2 border-t border-border pt-3">
          <label className="flex-1 text-sm">
            <span className="text-text-muted">{t('resources.skills.newName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={!name.trim() || createMut.isPending}
            className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
          >
            {t('resources.skills.add')}
          </button>
        </form>
      </div>
    </Modal>
  );
}
