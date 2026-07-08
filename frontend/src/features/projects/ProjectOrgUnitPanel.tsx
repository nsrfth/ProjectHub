import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import * as portfolioApi from '@/features/portfolio/api';

function flattenNodes(nodes: portfolioApi.OrgUnitTreeNode[]): portfolioApi.OrgUnitTreeNode[] {
  const out: portfolioApi.OrgUnitTreeNode[] = [];
  for (const n of nodes) {
    out.push(n, ...flattenNodes(n.children));
  }
  return out;
}

interface ProjectOrgUnitPanelProps {
  teamId: string;
  projectId: string;
  canAttach: boolean;
}

// v1.99 (PMIS R3): attach a project to an org-unit node for portfolio roll-up.
export default function ProjectOrgUnitPanel({
  teamId,
  projectId,
  canAttach,
}: ProjectOrgUnitPanelProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const { data: tree = [] } = useQuery({
    queryKey: ['portfolio', 'tree'],
    queryFn: portfolioApi.listOrgUnitTree,
    enabled: canAttach,
    staleTime: 60_000,
  });

  // v2.5.51: load the project's current attachment so the picker reflects it
  // on reopen. Previously the select was write-only (defaultValue="") and always
  // reset to the placeholder even when a unit was attached.
  const { data: current } = useQuery({
    queryKey: ['project', projectId, 'org-unit'],
    queryFn: () => portfolioApi.getProjectOrgUnit(teamId, projectId),
    enabled: canAttach,
  });

  const flat = flattenNodes(tree);

  // Controlled selection, seeded from the fetched assignment ('' = none).
  const [selected, setSelected] = useState<string>('');
  useEffect(() => {
    setSelected(current?.orgUnitId ?? '');
  }, [current?.orgUnitId]);

  const attachMut = useMutation({
    mutationFn: (orgUnitId: string | null) =>
      portfolioApi.setProjectOrgUnit(teamId, projectId, orgUnitId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio'] });
      qc.invalidateQueries({ queryKey: ['project', projectId, 'org-unit'] });
    },
  });

  if (!canAttach) return <></>;

  return (
    <section className="border-t border-border pt-3">
      <h3 className="text-sm font-medium mb-1">{t('portfolio.projectAttach')}</h3>
      <p className="text-xs text-text-muted mb-2">{t('portfolio.projectAttachHint')}</p>
      <select
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          setSelected(v === '__none__' ? '' : v);
          attachMut.mutate(v === '__none__' ? null : v);
        }}
        className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-700"
      >
        <option value="" disabled>
          {t('portfolio.chooseOrgUnit')}
        </option>
        <option value="__none__">{t('portfolio.detach')}</option>
        {flat.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name} ({n.type})
          </option>
        ))}
      </select>
      {attachMut.isSuccess && (
        <p className="text-xs text-success mt-1">{t('portfolio.saved')}</p>
      )}
    </section>
  );
}
