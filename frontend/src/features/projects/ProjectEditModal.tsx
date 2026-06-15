import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Modal from '@/features/ui/Modal';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
import { useT } from '@/lib/i18n';
import type { ProjectCrossTeam } from '@/features/projects/api';
import ProjectFormFields, {
  projectFormValuesFromProject,
  validateProjectDateRange,
  type ProjectFormValues,
} from '@/features/projects/ProjectFormFields';

interface ProjectEditModalProps {
  project: ProjectCrossTeam;
  nameOnly?: boolean;
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (values: ProjectFormValues) => void;
}

export default function ProjectEditModal({
  project,
  nameOnly = false,
  pending,
  error,
  onClose,
  onSave,
}: ProjectEditModalProps): JSX.Element {
  const t = useT();
  const [values, setValues] = useState<ProjectFormValues>(() => projectFormValuesFromProject(project));
  const [dateError, setDateError] = useState<string | null>(null);

  const { data: membersRaw = [] } = useQuery({
    queryKey: ['teams', project.teamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(project.teamId),
    staleTime: 30_000,
  });
  const members = visibleTeamMembers(membersRaw);

  useEffect(() => {
    setValues(projectFormValuesFromProject(project));
    setDateError(null);
  }, [project]);

  function patch(patch: Partial<ProjectFormValues>): void {
    setValues((prev) => {
      const next = { ...prev, ...patch };
      setDateError(validateProjectDateRange(next.startDate, next.endDate));
      return next;
    });
  }

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = values.name.trim();
    if (!trimmed) return;
    const rangeErr = validateProjectDateRange(values.startDate, values.endDate);
    if (rangeErr) {
      setDateError(rangeErr);
      return;
    }
    if (
      !nameOnly &&
      values.budgetCurrency !== project.budgetCurrency &&
      !window.confirm(t('budget.currencyChangeNote'))
    ) {
      return;
    }
    onSave({ ...values, name: trimmed, description: values.description.trim() });
  }

  return (
    <Modal title={t('projects.edit.title')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {nameOnly && (
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('projects.edit.nameOnlyHint')}</p>
        )}
        <ProjectFormFields
          values={values}
          onChange={patch}
          members={members}
          nameOnly={nameOnly}
          dateError={dateError}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border">
            {t('projects.edit.cancel')}
          </button>
          <button
            type="submit"
            disabled={pending || !values.name.trim() || !!dateError}
            className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white disabled:opacity-50"
          >
            {t('projects.edit.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export type { ProjectFormValues };
