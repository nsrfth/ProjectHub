import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import * as teamsApi from '@/features/teams/api';
import { useT } from '@/lib/i18n';

// v2.15: full division removal, restored from the retired Members tab and
// packaged as a self-contained flow. The owned-projects blocker logic is the
// valuable part: a person who owns projects cannot be silently removed — the
// caller must reassign ownership or explicitly force.
//
// Usage: render <RemoveFromDivisionTrigger .../> anywhere a member appears;
// it owns its confirm path, dialog, and mutation.

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function RemoveFromDivisionTrigger({
  teamId,
  member,
  reassignCandidates,
  onRemoved,
}: {
  teamId: string;
  member: { userId: string; name: string };
  /** Division members offered as new owners (the target is filtered out). */
  reassignCandidates: { userId: string; name: string; email: string }[];
  onRemoved: () => Promise<void> | void;
}): JSX.Element {
  const t = useT();
  const [blockers, setBlockers] = useState<teamsApi.MemberRemovalBlockers | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reassignOwnerTo, setReassignOwnerTo] = useState('');
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const removeMut = useMutation({
    mutationFn: (opts?: teamsApi.RemoveMemberOptions) =>
      teamsApi.removeMember(teamId, member.userId, opts),
    onSuccess: async () => {
      close();
      await onRemoved();
    },
    onError: (err) => setError(errorMessage(err, t('team.remove.error'))),
  });

  function close(): void {
    setOpen(false);
    setBlockers(null);
    setReassignOwnerTo('');
    setForce(false);
    setError(null);
  }

  async function begin(): Promise<void> {
    setLoading(true);
    try {
      const b = await teamsApi.getMemberRemovalBlockers(teamId, member.userId);
      const hasBlockers = b.ownedProjectCount > 0 || b.accountableProjectCount > 0;
      if (!hasBlockers) {
        if (window.confirm(t('team.remove.confirm').replace('{name}', member.name))) {
          removeMut.mutate(undefined);
        }
        return;
      }
      setBlockers(b);
      setOpen(true);
    } catch (err) {
      window.alert(errorMessage(err, t('team.remove.error')));
    } finally {
      setLoading(false);
    }
  }

  const options = reassignCandidates.filter((m) => m.userId !== member.userId);

  return (
    <>
      <button
        type="button"
        disabled={loading}
        onClick={() => void begin()}
        className="text-xs text-danger hover:underline disabled:opacity-50"
        data-testid="remove-from-division"
      >
        {t('units.removeFromDivision')}
      </button>

      {open && blockers && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-member-title"
        >
          <div className="bg-surface rounded-lg shadow-xl max-w-md w-full p-5">
            <h3 id="remove-member-title" className="text-lg font-semibold mb-2">
              {t('team.remove.confirm').replace('{name}', member.name)}
            </h3>
            {blockers.ownedProjectCount > 0 && (
              <p className="text-sm text-text mb-2">{t('team.remove.ownsProjects')}</p>
            )}
            {(blockers.ownedProjects.length > 0 || blockers.accountableProjects.length > 0) && (
              <ul className="list-disc ps-5 space-y-0.5 mb-3 text-sm text-text">
                {blockers.ownedProjects.map((p) => (
                  <li key={p.id}>{p.name}</li>
                ))}
                {blockers.accountableProjects.map((p) => (
                  <li key={p.id}>{p.name}</li>
                ))}
              </ul>
            )}
            {blockers.ownedProjectCount > 0 && (
              <div className="space-y-3 mb-4">
                <label className="block text-sm">
                  {t('team.remove.reassignTo')}
                  <select
                    value={reassignOwnerTo}
                    onChange={(e) => {
                      setReassignOwnerTo(e.target.value);
                      if (e.target.value) setForce(false);
                    }}
                    className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                  >
                    <option value="">—</option>
                    {options.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} ({m.email})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-danger">
                  <input
                    type="checkbox"
                    checked={force}
                    onChange={(e) => {
                      setForce(e.target.checked);
                      if (e.target.checked) setReassignOwnerTo('');
                    }}
                  />
                  {t('team.remove.removeAnyway')}
                </label>
              </div>
            )}
            {error && (
              <p className="text-xs text-danger mb-2" role="alert">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="border rounded px-3 py-1.5 text-sm hover:bg-bg-elevated"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={
                  removeMut.isPending ||
                  (blockers.ownedProjectCount > 0 && !reassignOwnerTo && !force)
                }
                onClick={() =>
                  removeMut.mutate({
                    reassignOwnerTo: reassignOwnerTo || undefined,
                    force: force || undefined,
                  })
                }
                className="bg-danger text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {t('units.removeFromDivision')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
