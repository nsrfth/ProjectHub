import { useNavigate } from 'react-router-dom';
import type { CalendarTask } from '@/features/calendar/api';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { sameDayUtc, utcDay } from '@/lib/calendarWeek';

const STATUS_STYLE: Record<CalendarTask['status'], string> = {
  TODO: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  IN_PROGRESS: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  REVIEW: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  DONE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
};

const PRIORITY_DOT: Record<CalendarTask['priority'], string> = {
  LOW: 'bg-slate-400',
  MEDIUM: 'bg-blue-500',
  HIGH: 'bg-orange-500',
  URGENT: 'bg-red-600',
};

interface Props {
  cells: Date[];
  byDay: Map<string, CalendarTask[]>;
  field: 'due' | 'planned';
}

function dayLabel(d: Date): string {
  const shamsi = formatShamsiCalendarDate(d.toISOString());
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(d);
  if (shamsi) return `${weekday}, ${shamsi}`;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export default function CalendarTimelineView({ cells, byDay, field }: Props): JSX.Element {
  const nav = useNavigate();
  const today = utcDay(new Date());

  return (
    <div className="space-y-4">
      {cells.map((day) => {
        const k = day.toISOString().slice(0, 10);
        const tasks = byDay.get(k) ?? [];
        const isToday = sameDayUtc(day, today);
        return (
          <section
            key={k}
            className={`rounded-lg border ${
              isToday
                ? 'border-indigo-300 dark:border-indigo-600 bg-indigo-50/30 dark:bg-indigo-950/20'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
            }`}
          >
            <header className="flex items-center justify-between px-4 py-2 border-b border-slate-100 dark:border-slate-700">
              <h2 className={`text-sm font-semibold ${isToday ? 'text-indigo-700 dark:text-indigo-300' : ''}`}>
                {dayLabel(day)}
                {isToday && (
                  <span className="ml-2 text-xs font-normal text-indigo-600 dark:text-indigo-400">Today</span>
                )}
              </h2>
              <span className="text-xs text-slate-500">
                {tasks.length} task{tasks.length === 1 ? '' : 's'}
              </span>
            </header>
            {tasks.length === 0 ? (
              <p className="px-4 py-3 text-xs text-slate-400 italic">No tasks on this {field === 'due' ? 'due' : 'planned'} date</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => nav(`/projects/${t.projectId}/tasks/${t.id}`)}
                      className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                    >
                      <span
                        className="w-1 self-stretch rounded-full shrink-0 min-h-[2.5rem]"
                        style={{ background: t.teamColor ?? '#cbd5e1' }}
                        aria-hidden
                      />
                      <span
                        className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[t.priority]}`}
                        title={t.priority}
                        aria-hidden
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {t.title}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                          {t.projectName}
                          {t.assigneeName ? ` · ${t.assigneeName}` : ''}
                          {t.teamName ? ` · ${t.teamName}` : ''}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded ${STATUS_STYLE[t.status]}`}
                      >
                        {t.status.replace('_', ' ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
