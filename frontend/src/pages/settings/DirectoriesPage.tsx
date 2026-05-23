import { useQuery } from '@tanstack/react-query';
import { listInstanceSettings } from '@/features/settings/api';

// Placeholder. Phase 1 ships the layout + plumbing; Phase 2 will replace this
// with the actual users/teams directory management surface. The query is
// scaffolded against the real /settings/instance endpoint so we know the
// authn + authz path works.
export default function DirectoriesPage(): JSX.Element {
  const { isLoading, error } = useQuery({
    queryKey: ['settings', 'instance'],
    queryFn: listInstanceSettings,
  });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Directories</h2>
      <p className="text-sm text-slate-500 mb-4">Users, teams, and invites.</p>
      {isLoading && <p className="text-sm text-slate-500">Checking instance settings…</p>}
      {error && (
        <p className="text-sm text-red-600">
          Couldn't reach /settings/instance — check the network tab.
        </p>
      )}
      <div className="rounded border border-dashed border-slate-300 p-6 text-sm text-slate-500">
        Coming in a future phase.
      </div>
    </section>
  );
}
