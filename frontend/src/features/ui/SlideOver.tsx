import { useId, useRef, type ReactNode } from 'react';
import { useDialog } from './useDialog';

export interface SlideOverProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export default function SlideOver({ title, onClose, children }: SlideOverProps): JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus trap, initial focus + restore, Escape, body scroll lock.
  useDialog(panelRef, onClose);

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex justify-end bg-black/40 dark:bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="slideover-panel bg-surface text-text w-full max-w-md h-full flex flex-col shadow-xl border-s border-border"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-text leading-snug">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:text-text hover:bg-surface-hover"
            aria-label="Close"
          >
            <span aria-hidden className="text-xl leading-none">×</span>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
