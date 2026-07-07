import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchMyTasks, type MeTask } from '@/features/meTasks/api';
import { formatShamsiDate } from '@/lib/shamsi';
import { addDaysUtc, utcDay, sameDayUtc } from '@/lib/calendarWeek';
import { getHolidayName, isOffDay } from '@/lib/calendar';

interface Props {
  limit?: number;
}

/** Compact week strip of the caller's assigned tasks (due date). */
export default function MyTasksCalendar({ limit = 200 }: Props): JSX.Element {
  const [cursor, setCursor] = useState(() => utcDay(new Date()));
  const start = cursor;
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysUtc(start, i)), [start]);

  const { data, isLoading } = useQuery({
    queryKey: ['me', 'tasks', 'calendar', limit],
    queryFn: () => fetchMyTasks({ limit, sort: 'dueDate', order: 'asc' }),
  });

  const tasks = useMemo(() => data?.items ?? [], [data]);

  const byDay = useMemo(() => {
    const m = new Map<string, MeTask[]>();
    for (const d of days) {
      m.set(d.toISOString(), []);
    }
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const due = new Date(t.dueDate);
      for (const d of days) {
        if (sameDayUtc(d, due)) {
          m.get(d.toISOString())!.push(t);
          break;
        }
      }
    }
    return m;
  }, [tasks, days]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2">
        <button
          type="button"
          className="text-sm px-2 py-1 border rounded"
          onClick={() => setCursor(addDaysUtc(cursor, -7))}
        >
          ←
        </button>
        <span className="text-sm text-text">
          Week of {formatShamsiDate(start.toISOString()) ?? start.toUTCString().slice(0, 10)}
        </span>
        <button
          type="button"
          className="text-sm px-2 py-1 border rounded"
          onClick={() => setCursor(addDaysUtc(cursor, 7))}
        >
          →
        </button>
      </div>
      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
        {days.map((d) => {
          const key = d.toISOString();
          const items = byDay.get(key) ?? [];
          const offDay = isOffDay(d);
          const holidayName = getHolidayName(d);
          return (
            <div
              key={key}
              className={[
                'rounded shadow p-2 min-h-[100px]',
                // Off days (weekend/holiday) get a soft warm-brown tint
                // (`--color-offday`) rather than an alarming red — red reads as
                // an error state; brown reads as "non-working".
                offDay ? 'bg-offday' : 'bg-surface',
              ].join(' ')}
              title={holidayName ?? undefined}
            >
              <div className={`text-xs font-medium mb-2 ${offDay ? 'text-text-muted' : 'text-slate-500'}`}>
                {formatShamsiDate(d.toISOString()) ?? d.getUTCDate()}
                {holidayName && (
                  <span className="block text-[10px] truncate">{holidayName}</span>
                )}
              </div>
              <ul className="space-y-1">
                {items.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <Link
                      to={`/projects/${t.projectId}/tasks/${t.id}`}
                      className="block text-xs truncate hover:underline text-primary"
                      title={t.title}
                    >
                      {t.title}
                    </Link>
                  </li>
                ))}
                {items.length > 5 && (
                  <li className="text-[10px] text-slate-400">+{items.length - 5} more</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
      {tasks.length === 0 && !isLoading && (
        <p className="text-sm text-slate-500 italic mt-4">No assigned tasks with due dates in this week.</p>
      )}
    </div>
  );
}
