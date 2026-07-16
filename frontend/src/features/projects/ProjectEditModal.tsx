import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Modal from '@/features/ui/Modal';
import { useAuth } from '@/features/auth/AuthContext';
import { getTeam, listTeamMembersForAssignees } from '@/features/teams/api';
import { useTeams } from '@/features/teams/TeamsContext';
import { visibleTeamMembers } from '@/lib/systemUser';
import { useT } from '@/lib/i18n';
import type { ProjectCrossTeam } from '@/features/projects/api';
import ProjectFormFields, {
  projectFormValuesFromProject,
  validateProjectDateRange,
  type ProjectFormValues,
} from '@/features/projects/ProjectFormFields';
import ProjectDelegatesField from '@/features/projects/ProjectDelegatesField';
import ProjectTeamSharesPanel from '@/features/projects/ProjectTeamSharesPanel';
import ProjectProfilePanel from '@/features/projects/ProjectProfilePanel';
import ProjectOrgUnitPanel from '@/features/projects/ProjectOrgUnitPanel';
import ProjectCostPanel from '@/features/projects/ProjectCostPanel';

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
  const { user } = useAuth();
  const { teams } = useTeams();
  const isOwnerOrAdmin =
    user?.globalRole === 'ADMIN' || user?.id === project.ownerId;
  const canPortfolio =
    user?.globalRole === 'ADMIN' ||
    teams.find((tm) => tm.id === project.teamId)?.myRole === 'MANAGER';
  const [values, setValues] = useState<ProjectFormValues>(() => projectFormValuesFromProject(project));
  const [dateError, setDateError] = useState<string | null>(null);

  const { data: membersRaw = [] } = useQuery({
    queryKey: ['teams', project.teamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(project.teamId),
    staleTime: 30_000,
  });
  const members = visibleTeamMembers(membersRaw);

  const { data: teamDetail } = useQuery({
    queryKey: ['teams', project.teamId, 'detail'],
    queryFn: () => getTeam(project.teamId),
    staleTime: 30_000,
    enabled: !nameOnly,
  });

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
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {nameOnly && (
          <p className="text-xs text-text-muted">{t('projects.edit.nameOnlyHint')}</p>
        )}
        <ProjectFormFields
          teamId={project.teamId}
          values={values}
          onChange={patch}
          members={members}
          nameOnly={nameOnly}
          dateError={dateError}
          hideBudget={!nameOnly}
          isOwnerOrAdmin={isOwnerOrAdmin}
        />
        {/* v1.86: owner-facing full-edit delegates — only in full-edit mode. */}
        {!nameOnly && (
          <ProjectDelegatesField
            teamId={project.teamId}
            projectId={project.id}
            members={members}
          />
        )}
        {/* v2.5.58: whole-team shares — global ADMIN only. */}
        {!nameOnly && user?.globalRole === 'ADMIN' && (
          <ProjectTeamSharesPanel teamId={project.teamId} projectId={project.id} />
        )}
        {!nameOnly && (
          <ProjectProfilePanel
            teamId={project.teamId}
            projectId={project.id}
            canManage={teamDetail?.capabilities.manageProfiles ?? false}
          />
        )}
        {!nameOnly && (
          <ProjectOrgUnitPanel
            teamId={project.teamId}
            projectId={project.id}
            canAttach={canPortfolio}
          />
        )}
        {!nameOnly && (
          <ProjectCostPanel
            teamId={project.teamId}
            projectId={project.id}
            canManage={canPortfolio}
          />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border">
            {t('projects.edit.cancel')}
          </button>
          <button
            type="submit"
            disabled={pending || !values.name.trim() || !!dateError}
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
          >
            {t('projects.edit.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export type { ProjectFormValues };
