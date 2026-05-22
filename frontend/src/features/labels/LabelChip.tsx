import type { TaskLabel } from './api';

// Pick legible foreground text given a label's background hex color.
// Uses the simple "relative luminance" formula — good enough for chips.
function readableTextOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#000';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Perceived luminance, ITU-R BT.601 weights.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#1f2937' : '#ffffff';
}

interface LabelChipProps {
  label: TaskLabel;
  size?: 'sm' | 'md';
  onRemove?: () => void;
}

export function LabelChip({ label, size = 'sm', onRemove }: LabelChipProps): JSX.Element {
  const fg = readableTextOn(label.color);
  const padding = size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-px text-[10px]';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded ${padding} font-medium`}
      style={{ backgroundColor: label.color, color: fg }}
    >
      {label.name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove label ${label.name}`}
          className="opacity-70 hover:opacity-100 leading-none"
        >
          ×
        </button>
      )}
    </span>
  );
}
