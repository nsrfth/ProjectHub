import { useQuery } from '@tanstack/react-query';
import { listInstanceSettings } from '@/features/settings/api';

export default function ApiWebhooksPage(): JSX.Element {
  const { isLoading } = useQuery({
    queryKey: ['settings', 'instance'],
    queryFn: listInstanceSettings,
  });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">API & Webhooks</h2>
      <p className="text-sm text-slate-500 mb-4">
        Outbound integrations and API keys.
      </p>
      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="rounded border border-dashed border-slate-300 p-6 text-sm text-slate-500">
        Coming in a future phase.
      </div>
    </section>
  );
}
