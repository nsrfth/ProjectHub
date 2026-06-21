import { useState } from 'react';

// v1.89: shared inline title editor. Renders the title text plus a pencil button
// (only when `canEdit`); clicking the pencil swaps to an input. Enter / blur
// saves (when changed + non-empty), Escape cancels. The caller owns the actual
// mutation via `onSave` and gates `canEdit` — the server is still the real
// authority (a granular EDIT_TITLES delegate, project WRITE, etc.).
interface InlineTitleEditProps {
  value: string;
  canEdit: boolean;
  onSave: (next: string) => void;
  saving?: boolean;
  /** Class applied to the read-only display text. */
  displayClassName?: string;
  /** Class applied to the edit <input>. */
  inputClassName?: string;
  /** Accessible label / tooltip for the pencil button. */
  editLabel: string;
  iconSize?: number;
}

function Pencil({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export default function InlineTitleEdit({
  value,
  canEdit,
  onSave,
  saving = false,
  displayClassName,
  inputClassName,
  editLabel,
  iconSize = 14,
}: InlineTitleEditProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function start(): void {
    setDraft(value);
    setEditing(true);
  }
  function commit(): void {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onSave(next);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className={inputClassName ?? 'rounded border border-border bg-surface px-2 py-1 text-sm'}
      />
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className={displayClassName}>{value}</span>
      {canEdit && (
        <button
          type="button"
          onClick={start}
          aria-label={editLabel}
          title={editLabel}
          className="shrink-0 text-text-muted opacity-60 hover:opacity-100 hover:text-primary transition-opacity"
        >
          <Pencil size={iconSize} />
        </button>
      )}
    </span>
  );
}
