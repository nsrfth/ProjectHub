import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TeamMember } from '@/features/teams/api';
import { useT } from '@/lib/i18n';
import {
  getProjectDelegates,
  setProjectDelegates,
  type DelegateCapability,
  type ProjectDelegate,
} from '@/features/projects/api';

interface ProjectDelegatesFieldProps {
  teamId: string;
  projectId: string;
  members: TeamMember[];
}

// Granular capabilities, in checklist order (FULL is the separate "all" box).
const GRANULAR: DelegateCapability[] = [
  'EDIT_TITLES',
  'EDIT_DETAILS',
  'EDIT_DATES',
  'CHANGE_RESPONSIBLE',
  'DELETE_TASKS',
];

// v1.88: owner-facing control to grant GRANULAR per-project capabilities to team
// members. Each member gets a capability checklist; ticking FULL implies (and
// disables) the rest. Self-contained fetch/save; only rendered in full-edit
// (owner/admin) mode, and the endpoints are owner/admin-gated server-side too.
export default function ProjectDelegatesField({
  teamId,
  projectId,
  members,
}: ProjectDelegatesFieldProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const delegatesKey = ['projects', teamId, projectId, 'delegates'];

  const { data: saved = [], isLoading } = useQuery({
    queryKey: delegatesKey,
    queryFn: () => getProjectDelegates(teamId, projectId),
    staleTime: 30_000,
  });

  // draft: userId -> capabilities. null until the owner edits something.
  const [draft, setDraft] = useState<Record<string, DelegateCapability[]> | null>(null);
  const savedMap: Record<string, DelegateCapability[]> = {};
  for (const d of saved) savedMap[d.userId] = d.capabilities;
  const current = draft ?? savedMap;
  const dirty =
    draft !== null && JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(savedMap));

  const mut = useMutation({
    mutationFn: (map: Record<string, DelegateCapability[]>) => {
      const delegates: ProjectDelegate[] = Object.entries(map)
        .filter(([, caps]) => caps.length > 0)
        .map(([userId, capabilities]) => ({ userId, capabilities }));
      return setProjectDelegates(teamId, projectId, delegates);
    },
    onSuccess: (delegates) => {
      qc.setQueryData(delegatesKey, delegates);
      setDraft(null);
    },
  });

  function capsFor(userId: string): DelegateCapability[] {
    return current[userId] ?? [];
  }

  function setCaps(userId: string, caps: DelegateCapability[]): void {
    setDraft((prev) => {
      const base = prev ?? savedMap;
      const next = { ...base };
      if (caps.length === 0) delete next[userId];
      else next[userId] = caps;
      return next;
    });
  }

  function toggleCap(userId: string, cap: DelegateCapability): void {
    const caps = new Set(capsFor(userId));
    if (cap === 'FULL') {
      if (caps.has('FULL')) caps.delete('FULL');
      else {
        caps.clear();
        caps.add('FULL');
      }
    } else {
      caps.delete('FULL'); // editing a granular box drops the implied FULL
      if (caps.has(cap)) caps.delete(cap);
      else caps.add(cap);
    }
    setCaps(userId, [...caps]);
  }

  // A granular box renders checked (and disabled) when FULL implies it.
  function checked(userId: string, cap: DelegateCapability): boolean {
    const caps = capsFor(userId);
    return caps.includes(cap) || (cap !== 'FULL' && caps.includes('FULL'));
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <div>
        <span className="text-sm font-medium">{t('projects.delegates.title')}</span>
        <p className="text-xs text-text-muted">{t('projects.delegates.hint')}</p>
      </div>
      {isLoading ? (
        <p className="text-xs text-text-muted">{t('projects.delegates.loading')}</p>
      ) : members.length === 0 ? (
        <p className="text-xs text-text-muted">{t('projects.delegates.none')}</p>
      ) : (
        <ul className="space-y-2 max-h-72 overflow-auto">
          {members.map((m) => {
            const full = capsFor(m.userId).includes('FULL');
            return (
              <li key={m.userId} className="border border-border rounded p-2">
                <div className="text-sm font-medium mb-1">
                  {m.name} <span className="text-text-muted font-normal">({m.role})</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={checked(m.userId, 'FULL')}
                      onChange={() => toggleCap(m.userId, 'FULL')}
                    />
                    <span>{t('projects.delegates.cap.FULL')}</span>
                  </label>
                  {GRANULAR.map((cap) => (
                    <label key={cap} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={checked(m.userId, cap)}
                        disabled={full}
                        onChange={() => toggleCap(m.userId, cap)}
                      />
                      <span>{t(`projects.delegates.cap.${cap}`)}</span>
                    </label>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => mut.mutate(current)}
          disabled={!dirty || mut.isPending}
          className="px-3 py-1.5 text-sm rounded border disabled:opacity-50"
        >
          {t('projects.delegates.save')}
        </button>
        {mut.isError && (
          <span className="text-xs text-danger" role="alert">
            {t('projects.delegates.error')}
          </span>
        )}
      </div>
    </div>
  );
}

// Stable comparison key: drop empty entries, sort capabilities.
function normalize(
  map: Record<string, DelegateCapability[]>,
): Record<string, DelegateCapability[]> {
  const out: Record<string, DelegateCapability[]> = {};
  for (const [k, v] of Object.entries(map)) if (v.length > 0) out[k] = [...v].sort();
  return out;
}
