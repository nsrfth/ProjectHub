import { useT } from '@/lib/i18n';

export interface ProjectActionsMenuProps {
  open: boolean;
  menuRef?: React.RefObject<HTMLDivElement>;
  onToggle: (e: React.MouseEvent) => void;
  onEdit: () => void;
  onEditBudget: () => void;
  onSetHealth?: () => void;
  onDelete: () => void;
}

export default function ProjectActionsMenu({
  open,
  menuRef,
  onToggle,
  onEdit,
  onEditBudget,
  onSetHealth,
  onDelete,
}: ProjectActionsMenuProps): JSX.Element {
  const t = useT();

  return (
    <div className="relative shrink-0" ref={open ? menuRef : undefined}>
      <button
        type="button"
        onClick={onToggle}
        className="text-sm px-1.5 py-0.5 rounded border text-text-muted hover:bg-bg-elevated"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('projects.actions')}
        title={t('projects.actions')}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full mt-1 z-20 min-w-[10rem] rounded border border-border bg-surface shadow-lg py-1 text-sm"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full text-start px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            {t('projects.action.edit')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full text-start px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700"
            onClick={(e) => {
              e.stopPropagation();
              onEditBudget();
            }}
          >
            {t('projects.action.editBudget')}
          </button>
          {onSetHealth && (
            <button
              type="button"
              role="menuitem"
              className="block w-full text-start px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={(e) => {
                e.stopPropagation();
                onSetHealth();
              }}
            >
              {t('projects.action.setHealth')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="block w-full text-start px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            {t('projects.action.delete')}
          </button>
        </div>
      )}
    </div>
  );
}
