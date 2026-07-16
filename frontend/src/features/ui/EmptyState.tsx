import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional call-to-action, e.g. a <Button>. */
  action?: ReactNode;
  icon?: ReactNode;
}

/**
 * Canonical empty state (v2.5.57): centred, quiet, with an optional next-step
 * action — so "no data yet" reads as guidance instead of a blank pane.
 */
export default function EmptyState({
  title,
  description,
  action,
  icon,
}: EmptyStateProps): JSX.Element {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && (
        <div className="text-text-muted" aria-hidden>
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-text">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-text-muted">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
