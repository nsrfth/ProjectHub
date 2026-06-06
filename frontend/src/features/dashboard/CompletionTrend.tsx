import type { DoneTaskRow } from '@/features/reports/api';

// v1.25: 30-day completion trend. Daily bars + a 7-day moving-average line
// overlay so the rhythm is visible without obscuring weekly bursts.
//
// Reads the existing /reports/done?days=30 payload — no new endpoint, no
// new fields. We bucket by completedAt's UTC calendar day.

interface Props {
  rows: DoneTaskRow[];
  /** Number of days to render. 30 fits the dashboard card width nicely. */
  days?: number;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD; cheap + stable
}

function shortLabel(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export default function CompletionTrend({ rows, days = 30 }: Props): JSX.Element {
  // Build a contiguous list of last N day keys ending today (UTC).
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const window: { key: string; date: Date; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtc.getTime() - i * 86_400_000);
    window.push({ key: d.toISOString().slice(0, 10), date: d, count: 0 });
  }
  const byKey = new Map(window.map((w) => [w.key, w]));
  for (const r of rows) {
    const slot = byKey.get(dayKey(r.completedAt));
    if (slot) slot.count += 1;
  }

  // 7-day trailing moving average. Anchored on each day; the first 6 days
  // average over what's available.
  const series = window.map((w, idx) => {
    const start = Math.max(0, idx - 6);
    const slice = window.slice(start, idx + 1);
    const avg = slice.reduce((s, x) => s + x.count, 0) / slice.length;
    return { ...w, avg };
  });

  const max = Math.max(1, ...series.map((s) => Math.max(s.count, s.avg)));

  // SVG geometry. Width is responsive via viewBox; height is fixed-ish.
  const W = 480;
  const H = 110;
  const padX = 8;
  const padY = 8;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const barW = innerW / series.length;

  // Build the moving-average polyline once.
  const linePoints = series
    .map((s, i) => {
      const x = padX + i * barW + barW / 2;
      const y = padY + innerH - (s.avg / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const total = window.reduce((s, w) => s + w.count, 0);
  const last7 = window.slice(-7).reduce((s, w) => s + w.count, 0);
  const prev7 = window.slice(-14, -7).reduce((s, w) => s + w.count, 0);
  const delta = last7 - prev7;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-500 dark:text-slate-400">
          Tasks completed · last {days} days
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          <span className="tabular-nums text-slate-900 dark:text-slate-100 font-medium">
            {total}
          </span>
          {' total · '}
          <span
            className={
              delta > 0
                ? 'text-emerald-600'
                : delta < 0
                  ? 'text-red-600'
                  : 'text-slate-500'
            }
          >
            {delta >= 0 ? '+' : ''}
            {delta}
          </span>
          {' vs prior 7d'}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
        aria-label="30-day completion trend"
      >
        {/* Bars. */}
        {series.map((s, i) => {
          const h = (s.count / max) * innerH;
          return (
            <rect
              key={s.key}
              x={padX + i * barW + 1}
              y={padY + innerH - h}
              width={Math.max(0, barW - 2)}
              height={h}
              className="fill-blue-400/70 dark:fill-blue-500/70"
            >
              <title>{`${shortLabel(s.date)}: ${s.count}`}</title>
            </rect>
          );
        })}
        {/* 7-day moving-average line. */}
        <polyline
          points={linePoints}
          fill="none"
          className="stroke-blue-700 dark:stroke-blue-300"
          strokeWidth="1.5"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{shortLabel(series[0]!.date)}</span>
        <span>{shortLabel(series[Math.floor(series.length / 2)]!.date)}</span>
        <span>{shortLabel(series[series.length - 1]!.date)}</span>
      </div>
    </div>
  );
}
