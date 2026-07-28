// Interactive Gantt — drag-to-reschedule, resize handles, infinite timeline
// scroll, markers, today line.
//
// ── Adapted from the upstream roadmap-ui Gantt. Three deliberate departures:
//
// 1. CALENDAR-AWARE GEOMETRY. Upstream derives offsets from date-fns month
//    arithmetic (differenceInMonths + getDaysInMonth), which hard-codes the
//    Gregorian calendar. This app is Jalali-first, so the timeline is instead
//    a flat array of explicit column bounds (`GanttColumnSpec`) built from
//    lib/shamsi's jalaliYearMonths under SHAMSI and Gregorian months
//    otherwise. Every offset/width/hit-test reads that array, so the columns,
//    the bars and the header labels can never disagree about where a month
//    starts. It also drops upstream's same-day zero-width bar bug — end dates
//    are inclusive calendar dates here, matching the repo convention, so a
//    one-day feature is one day wide.
//
// 2. UTC-MIDNIGHT CALENDAR DAYS. All geometry runs on the repo's standard
//    UTC-midnight ms (see ARCHITECTURE "Dates"). date-fns is local-time based
//    and would shift a day for anyone not on UTC, so it is used only for the
//    timezone-insensitive duration string, never for positioning.
//
// 3. NO PER-COLUMN HOOKS. Upstream mounts a component with three hooks per
//    column; in daily range over three years that is ~1100 subscriptions. The
//    add-feature affordance is driven by one handler on the column container
//    instead.
//
// RTL: the scroll container is pinned dir="ltr" because the timeline is a
// left-to-right number line — mirroring it would invert every offset. Text
// inside the sidebar uses dir="auto" so Persian project names still read
// correctly. Off-days come from lib/calendar's isOffDay, so the configurable
// weekend (Thu+Fri vs Sat+Sun) and holidays both tint correctly.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  FC,
  KeyboardEventHandler,
  MouseEvent as ReactMouseEvent,
  MouseEventHandler,
  ReactNode,
  RefObject,
} from 'react';
import { DndContext, MouseSensor, useDraggable, useSensor } from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import { useMouse, useThrottle } from '@uidotdev/usehooks';
import { formatDistanceStrict } from 'date-fns';
import { atom, useAtom } from 'jotai';
import throttle from 'lodash.throttle';
import { PlusIcon, TrashIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { getCalendar, type Calendar } from '@/lib/calendar';
import { jalaliYearOfUtcMs } from '@/lib/shamsi';
import { cn } from '@/lib/utils';
import {
  BASE_COLUMN_WIDTH,
  MS_DAY,
  buildGanttColumns,
  msAtOffset,
  offsetOfMs,
  todayUtcMs,
  utcDayMs,
  widthOfSpan,
  type GanttColumnSpec,
  type Range,
} from './gantt-geometry';

// Re-exported so callers import the whole Gantt surface from one module.
export {
  BASE_COLUMN_WIDTH,
  buildGanttColumns,
  msAtOffset,
  offsetOfMs,
  todayUtcMs,
  utcDayMs,
  widthOfSpan,
};
export type { GanttColumnSpec, Range };

const draggingAtom = atom(false);
const scrollXAtom = atom(0);

export const useGanttDragging = () => useAtom(draggingAtom);
export const useGanttScrollX = () => useAtom(scrollXAtom);

export type GanttStatus = {
  id: string;
  name: string;
  color: string;
};

export type GanttFeature = {
  id: string;
  name: string;
  /** UTC-midnight calendar date. */
  startAt: Date;
  /** UTC-midnight calendar date, INCLUSIVE — a same-day feature is 1 day wide. */
  endAt: Date;
  status: GanttStatus;
};

export type GanttMarkerProps = {
  id: string;
  date: Date;
  label: string;
};

export type GanttContextProps = {
  zoom: number;
  range: Range;
  /** Base column width before zoom. */
  columnWidth: number;
  /** Effective column width in px, zoom applied. */
  colW: number;
  sidebarWidth: number;
  headerHeight: number;
  rowHeight: number;
  onAddItem: ((date: Date) => void) | undefined;
  columns: GanttColumnSpec[];
  calendar: Calendar;
  ref: RefObject<HTMLDivElement | null> | null;
};

function utcDate(ms: number): Date {
  return new Date(ms);
}

const GanttContext = createContext<GanttContextProps>({
  zoom: 100,
  range: 'monthly',
  columnWidth: 150,
  colW: 150,
  headerHeight: 60,
  sidebarWidth: 300,
  rowHeight: 36,
  onAddItem: undefined,
  columns: [],
  calendar: 'GREGORIAN',
  ref: null,
});

/** Pointer x within the timeline content, in timeline pixels. */
function useTimelineMouseX(): () => number {
  const gantt = useContext(GanttContext);
  const [scrollX] = useGanttScrollX();
  const [mouse] = useMouse<HTMLDivElement>();

  return useCallback(() => {
    const rect = gantt.ref?.current?.getBoundingClientRect();
    return mouse.x - (rect?.left ?? 0) + scrollX - gantt.sidebarWidth;
  }, [gantt.ref, gantt.sidebarWidth, mouse.x, scrollX]);
}

// ── Header ────────────────────────────────────────────────────────────────

export type GanttContentHeaderProps = {
  renderHeaderItem: (index: number) => ReactNode;
  title: string;
  columns: number;
};

export const GanttContentHeader: FC<GanttContentHeaderProps> = ({
  title,
  columns,
  renderHeaderItem,
}) => {
  const id = useId();

  return (
    <div
      className="sticky top-0 z-20 grid w-full shrink-0 bg-bg/90 backdrop-blur-sm"
      style={{ height: 'var(--gantt-header-height)' }}
    >
      <div>
        <div
          className="sticky inline-flex whitespace-nowrap px-3 py-2 text-xs text-text-muted"
          style={{ left: 'var(--gantt-sidebar-width)' }}
          dir="auto"
        >
          <p>{title}</p>
        </div>
      </div>
      <div
        className="grid w-full"
        style={{ gridTemplateColumns: `repeat(${columns}, var(--gantt-column-width))` }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <div
            key={`${id}-${index}`}
            className="shrink-0 border-b border-border/50 py-1 text-center text-xs text-text"
          >
            {renderHeaderItem(index)}
          </div>
        ))}
      </div>
    </div>
  );
};

export type GanttHeaderProps = {
  className?: string;
};

/**
 * One generic header for all three ranges — columns are bucketed by their
 * groupKey, so daily groups by month, monthly by year, quarterly by quarter.
 */
export const GanttHeader: FC<GanttHeaderProps> = ({ className }) => {
  const gantt = useContext(GanttContext);

  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; columns: GanttColumnSpec[] }> = [];
    for (const column of gantt.columns) {
      const tail = out.at(-1);
      if (tail && tail.key === column.groupKey) tail.columns.push(column);
      else out.push({ key: column.groupKey, label: column.groupLabel, columns: [column] });
    }
    return out;
  }, [gantt.columns]);

  return (
    <div className={cn('-space-x-px flex h-full w-max divide-x divide-border/50', className)}>
      {groups.map((group) => (
        <div className="relative flex flex-col" key={group.key}>
          <GanttContentHeader
            title={group.label}
            columns={group.columns.length}
            renderHeaderItem={(index) => <p>{group.columns[index]?.label}</p>}
          />
          <GanttColumns columns={group.columns} />
        </div>
      ))}
    </div>
  );
};

// ── Columns / add-feature affordance ──────────────────────────────────────

export type GanttColumnsProps = {
  columns: GanttColumnSpec[];
};

/**
 * The background grid for one header group. A single mousemove handler drives
 * the add-feature affordance for every column in the group — upstream mounted
 * three hooks per column, which is ~1100 subscriptions in daily range.
 */
export const GanttColumns: FC<GanttColumnsProps> = ({ columns }) => {
  const id = useId();
  const gantt = useContext(GanttContext);
  const [dragging] = useGanttDragging();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ top: number; left: number } | null>(null);

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!gantt.onAddItem || dragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ top: event.clientY - rect.top, left: event.clientX - rect.left });
  };

  const handleAdd = () => {
    if (!hover) return;
    const columnIndex = Math.min(
      Math.max(Math.floor(hover.left / gantt.colW), 0),
      columns.length - 1,
    );
    const column = columns[columnIndex];
    if (!column) return;
    const fraction = (hover.left - columnIndex * gantt.colW) / gantt.colW;
    const dayOffset = Math.min(
      Math.max(Math.floor(fraction * column.days), 0),
      column.days - 1,
    );
    gantt.onAddItem?.(utcDate(column.startMs + dayOffset * MS_DAY));
  };

  return (
    <div
      ref={containerRef}
      className="relative grid h-full w-full divide-x divide-border/50"
      style={{ gridTemplateColumns: `repeat(${columns.length}, var(--gantt-column-width))` }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHover(null)}
    >
      {columns.map((column, index) => (
        <div
          key={`${id}-${index}`}
          className={cn('h-full', column.isOff && 'bg-offday')}
          aria-hidden="true"
        />
      ))}
      {gantt.onAddItem && hover && !dragging ? (
        <GanttAddFeatureHelper top={hover.top} left={hover.left} onAdd={handleAdd} />
      ) : null}
    </div>
  );
};

export type GanttAddFeatureHelperProps = {
  top: number;
  left: number;
  onAdd: () => void;
  className?: string;
};

export const GanttAddFeatureHelper: FC<GanttAddFeatureHelperProps> = ({
  top,
  left,
  onAdd,
  className,
}) => {
  const gantt = useContext(GanttContext);

  return (
    <div
      className={cn('pointer-events-none absolute top-0 px-0.5', className)}
      style={{
        width: gantt.colW,
        height: gantt.rowHeight,
        transform: `translate(${Math.floor(left / gantt.colW) * gantt.colW}px, ${
          top - gantt.rowHeight / 2
        }px)`,
      }}
    >
      <button
        onClick={onAdd}
        type="button"
        className="pointer-events-auto flex h-full w-full items-center justify-center rounded-md border border-dashed border-border hover:bg-surface-hover"
      >
        <PlusIcon size={16} className="pointer-events-none select-none text-text-muted" />
      </button>
    </div>
  );
};

// ── Sidebar ───────────────────────────────────────────────────────────────

export type GanttSidebarItemProps = {
  feature: GanttFeature;
  onSelectItem?: (id: string) => void;
  className?: string;
  /** Overrides the computed duration text (e.g. a Shamsi-formatted range). */
  durationLabel?: string;
};

export const GanttSidebarItem: FC<GanttSidebarItemProps> = ({
  feature,
  onSelectItem,
  className,
  durationLabel,
}) => {
  // date-fns is safe here: a duration between two UTC-midnight instants is
  // timezone-insensitive. It is NOT used for positioning — see the file header.
  const duration =
    durationLabel ??
    formatDistanceStrict(feature.startAt, new Date(feature.endAt.getTime() + MS_DAY));

  const handleClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.target === event.currentTarget) onSelectItem?.(feature.id);
  };

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectItem?.(feature.id);
    }
  };

  return (
    <div
      role="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      className={cn(
        'relative flex items-center gap-2.5 p-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      style={{ height: 'var(--gantt-row-height)' }}
    >
      <div
        className="pointer-events-none h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: feature.status.color }}
      />
      <p className="pointer-events-none flex-1 truncate text-start font-medium text-text" dir="auto">
        {feature.name}
      </p>
      <p className="pointer-events-none shrink-0 text-text-muted" dir="auto">
        {duration}
      </p>
    </div>
  );
};

export type GanttSidebarHeaderProps = {
  /** Defaults kept English-free so callers pass translated strings. */
  nameLabel?: string;
  durationLabel?: string;
};

export const GanttSidebarHeader: FC<GanttSidebarHeaderProps> = ({
  nameLabel = 'Name',
  durationLabel = 'Duration',
}) => (
  <div
    className="sticky top-0 z-10 flex shrink-0 items-end justify-between gap-2.5 border-b border-border/50 bg-bg/90 p-2.5 text-xs font-medium text-text-muted backdrop-blur-sm"
    style={{ height: 'var(--gantt-header-height)' }}
  >
    <p className="flex-1 truncate text-start">{nameLabel}</p>
    <p className="shrink-0">{durationLabel}</p>
  </div>
);

export type GanttSidebarGroupProps = {
  children: ReactNode;
  name: string;
  className?: string;
};

export const GanttSidebarGroup: FC<GanttSidebarGroupProps> = ({
  children,
  name,
  className,
}) => (
  <div className={className}>
    <p
      style={{ height: 'var(--gantt-row-height)' }}
      className="w-full truncate p-2.5 text-start text-xs font-medium text-text-muted"
      dir="auto"
    >
      {name}
    </p>
    <div className="divide-y divide-border/50">{children}</div>
  </div>
);

export type GanttSidebarProps = {
  children: ReactNode;
  className?: string;
  header?: ReactNode;
};

export const GanttSidebar: FC<GanttSidebarProps> = ({ children, className, header }) => (
  <div
    data-roadmap-ui="gantt-sidebar"
    className={cn(
      'sticky left-0 z-30 h-max min-h-full overflow-clip border-e border-border/50 bg-surface/95 backdrop-blur-md',
      className,
    )}
  >
    {header ?? <GanttSidebarHeader />}
    <div className="space-y-4">{children}</div>
  </div>
);

// ── Markers / today ───────────────────────────────────────────────────────

type VerticalLineProps = {
  ms: number;
  label: string;
  secondaryLabel?: string;
  className?: string;
  children?: ReactNode;
};

const GanttVerticalLine: FC<VerticalLineProps> = ({
  ms,
  label,
  secondaryLabel,
  className,
  children,
}) => {
  const gantt = useContext(GanttContext);
  const offset = offsetOfMs(gantt.columns, gantt.colW, ms);

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-20 flex h-full select-none flex-col items-center justify-center overflow-visible"
      style={{ width: 0, transform: `translateX(${offset}px)` }}
    >
      {children ?? (
        <div
          className={cn(
            'group pointer-events-auto sticky top-0 flex select-auto flex-col flex-nowrap items-center justify-center whitespace-nowrap rounded-b-md bg-surface px-2 py-1 text-xs text-text shadow-sm',
            className,
          )}
          dir="auto"
        >
          {label}
          {secondaryLabel ? (
            <span className="max-h-0 overflow-hidden opacity-80 transition-all group-hover:max-h-8">
              {secondaryLabel}
            </span>
          ) : null}
        </div>
      )}
      <div className={cn('h-full w-px bg-border', className)} />
    </div>
  );
};

export const GanttMarker: FC<
  GanttMarkerProps & { onRemove?: (id: string) => void; removeLabel?: string; className?: string }
> = ({ label, date, id, onRemove, removeLabel = 'Remove marker', className }) => {
  const gantt = useContext(GanttContext);
  const offset = offsetOfMs(gantt.columns, gantt.colW, utcDayMs(date));

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-20 flex h-full select-none flex-col items-center justify-center overflow-visible"
      style={{ width: 0, transform: `translateX(${offset}px)` }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group pointer-events-auto sticky top-0 flex select-auto flex-col flex-nowrap items-center justify-center whitespace-nowrap rounded-b-md bg-surface px-2 py-1 text-xs text-text shadow-sm',
              className,
            )}
            dir="auto"
          >
            {label}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onRemove ? (
            <ContextMenuItem
              className="flex items-center gap-2 text-danger"
              onClick={() => onRemove(id)}
            >
              <TrashIcon size={16} />
              {removeLabel}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <div className={cn('h-full w-px bg-border', className)} />
    </div>
  );
};

export type GanttTodayProps = {
  className?: string;
  label?: string;
  dateLabel?: string;
};

export const GanttToday: FC<GanttTodayProps> = ({ className, label = 'Today', dateLabel }) => (
  <GanttVerticalLine
    ms={todayUtcMs()}
    label={label}
    secondaryLabel={dateLabel}
    className={cn('bg-primary text-primary-contrast', className)}
  />
);

export type GanttCreateMarkerTriggerProps = {
  onCreateMarker: (date: Date) => void;
  formatLabel?: (date: Date) => string;
  className?: string;
};

export const GanttCreateMarkerTrigger: FC<GanttCreateMarkerTriggerProps> = ({
  onCreateMarker,
  formatLabel,
  className,
}) => {
  const gantt = useContext(GanttContext);
  const timelineX = useTimelineMouseX();
  const x = useThrottle(timelineX(), 10);
  const ms = msAtOffset(gantt.columns, gantt.colW, x);

  return (
    <div
      className={cn(
        'group pointer-events-none absolute top-0 left-0 h-full w-full select-none overflow-visible',
        className,
      )}
    >
      <div
        className="-ml-2 pointer-events-auto sticky top-6 z-20 flex w-4 flex-col items-center justify-center gap-1 overflow-visible opacity-0 group-hover:opacity-100"
        style={{ transform: `translateX(${offsetOfMs(gantt.columns, gantt.colW, ms)}px)` }}
      >
        <button
          type="button"
          className="z-50 inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface shadow"
          onClick={() => onCreateMarker(utcDate(ms))}
        >
          <PlusIcon size={12} className="text-text-muted" />
        </button>
        <div className="whitespace-nowrap rounded-full border border-border/50 bg-surface/90 px-2 py-1 text-xs text-text backdrop-blur-lg">
          {formatLabel ? formatLabel(utcDate(ms)) : new Date(ms).toISOString().slice(0, 10)}
        </div>
      </div>
    </div>
  );
};

// ── Feature bars ──────────────────────────────────────────────────────────

export type GanttFeatureDragHelperProps = {
  featureId: GanttFeature['id'];
  direction: 'left' | 'right';
  label: string | null;
};

export const GanttFeatureDragHelper: FC<GanttFeatureDragHelperProps> = ({
  direction,
  featureId,
  label,
}) => {
  const [, setDragging] = useGanttDragging();
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `feature-drag-helper-${featureId}-${direction}`,
  });
  const isPressed = Boolean(attributes['aria-pressed']);

  useEffect(() => setDragging(isPressed), [isPressed, setDragging]);

  return (
    <div
      className={cn(
        'group -translate-y-1/2 !cursor-col-resize absolute top-1/2 z-[3] h-full w-6 rounded-md outline-none',
        direction === 'left' ? '-left-2.5' : '-right-2.5',
      )}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
    >
      <div
        className={cn(
          '-translate-y-1/2 absolute top-1/2 h-[80%] w-1 rounded-sm bg-text-muted opacity-0 transition-all',
          direction === 'left' ? 'left-2.5' : 'right-2.5',
          direction === 'left' ? 'group-hover:left-0' : 'group-hover:right-0',
          isPressed && (direction === 'left' ? 'left-0' : 'right-0'),
          'group-hover:opacity-100',
          isPressed && 'opacity-100',
        )}
      />
      {label && (
        <div
          className={cn(
            '-translate-x-1/2 absolute top-10 hidden whitespace-nowrap rounded-lg border border-border/50 bg-surface/90 px-2 py-1 text-xs text-text backdrop-blur-lg group-hover:block',
            isPressed && 'block',
          )}
        >
          {label}
        </div>
      )}
    </div>
  );
};

export type GanttFeatureItemCardProps = Pick<GanttFeature, 'id'> & {
  children?: ReactNode;
  className?: string;
};

export const GanttFeatureItemCard: FC<GanttFeatureItemCardProps> = ({
  id,
  children,
  className,
}) => {
  const [, setDragging] = useGanttDragging();
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  const isPressed = Boolean(attributes['aria-pressed']);

  useEffect(() => setDragging(isPressed), [isPressed, setDragging]);

  return (
    <Card
      className={cn('relative h-full w-full overflow-hidden rounded-md p-0 text-xs', className)}
    >
      <div
        className={cn(
          'flex h-full w-full items-center justify-between gap-2 px-2 text-start',
          isPressed ? 'cursor-grabbing' : 'cursor-grab',
        )}
        {...attributes}
        {...listeners}
        ref={setNodeRef}
      >
        {children}
      </div>
    </Card>
  );
};

export type GanttFeatureItemProps = GanttFeature & {
  /** Omit to make the bar read-only — the resize handles disappear. */
  onMove?: (id: string, startAt: Date, endAt: Date) => void;
  /** Tooltip text on the resize handles, e.g. a Shamsi date. */
  formatHandleLabel?: (date: Date) => string;
  children?: ReactNode;
  className?: string;
  cardClassName?: string;
};

export const GanttFeatureItem: FC<GanttFeatureItemProps> = ({
  onMove,
  formatHandleLabel,
  children,
  className,
  cardClassName,
  ...feature
}) => {
  const gantt = useContext(GanttContext);
  const timelineX = useTimelineMouseX();
  const [mouse] = useMouse<HTMLDivElement>();

  const [startMs, setStartMs] = useState(() => utcDayMs(feature.startAt));
  const [endMs, setEndMs] = useState(() => utcDayMs(feature.endAt));

  // Re-sync when the owning list gives us new dates (e.g. a save round-trips,
  // or a filter swaps the row) — otherwise local drag state would win forever.
  const featureStart = utcDayMs(feature.startAt);
  const featureEnd = utcDayMs(feature.endAt);
  useEffect(() => {
    setStartMs(featureStart);
    setEndMs(featureEnd);
  }, [featureStart, featureEnd]);

  const dragOrigin = useRef({ mouseX: 0, startMs: 0, endMs: 0 });

  const left = offsetOfMs(gantt.columns, gantt.colW, startMs);
  const width = widthOfSpan(gantt.columns, gantt.colW, startMs, endMs);

  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 10 } });

  const handleItemDragStart = () => {
    dragOrigin.current = { mouseX: mouse.x, startMs, endMs };
  };

  const handleItemDragMove = () => {
    const { mouseX, startMs: originStart, endMs: originEnd } = dragOrigin.current;
    // Convert the pixel delta to whole days through the column array so the
    // step matches the visible grid in every range and calendar.
    const from = msAtOffset(gantt.columns, gantt.colW, timelineX() - (mouse.x - mouseX));
    const to = msAtOffset(gantt.columns, gantt.colW, timelineX());
    const deltaDays = Math.round((to - from) / MS_DAY);
    if (!deltaDays) return;
    setStartMs(originStart + deltaDays * MS_DAY);
    setEndMs(originEnd + deltaDays * MS_DAY);
  };

  const handleLeftDragMove = () => {
    const next = msAtOffset(gantt.columns, gantt.colW, timelineX());
    setStartMs(Math.min(next, endMs));
  };

  const handleRightDragMove = () => {
    const next = msAtOffset(gantt.columns, gantt.colW, timelineX());
    setEndMs(Math.max(next, startMs));
  };

  const commit = () => onMove?.(feature.id, utcDate(startMs), utcDate(endMs));

  return (
    <div
      className={cn('relative flex w-max min-w-full py-0.5', className)}
      style={{ height: 'var(--gantt-row-height)' }}
    >
      <div
        className="pointer-events-auto absolute top-0.5"
        style={{
          height: 'calc(var(--gantt-row-height) - 4px)',
          width: Math.round(width),
          left: Math.round(left),
        }}
      >
        {onMove && (
          <DndContext
            sensors={[mouseSensor]}
            modifiers={[restrictToHorizontalAxis]}
            onDragMove={handleLeftDragMove}
            onDragEnd={commit}
          >
            <GanttFeatureDragHelper
              direction="left"
              featureId={feature.id}
              label={formatHandleLabel ? formatHandleLabel(utcDate(startMs)) : null}
            />
          </DndContext>
        )}
        <DndContext
          sensors={[mouseSensor]}
          modifiers={[restrictToHorizontalAxis]}
          onDragStart={handleItemDragStart}
          onDragMove={handleItemDragMove}
          onDragEnd={commit}
        >
          <GanttFeatureItemCard id={feature.id} className={cardClassName}>
            {children ?? (
              <p className="flex-1 truncate text-xs text-text" dir="auto">
                {feature.name}
              </p>
            )}
          </GanttFeatureItemCard>
        </DndContext>
        {onMove && (
          <DndContext
            sensors={[mouseSensor]}
            modifiers={[restrictToHorizontalAxis]}
            onDragMove={handleRightDragMove}
            onDragEnd={commit}
          >
            <GanttFeatureDragHelper
              direction="right"
              featureId={feature.id}
              label={formatHandleLabel ? formatHandleLabel(utcDate(endMs)) : null}
            />
          </DndContext>
        )}
      </div>
    </div>
  );
};

export type GanttFeatureListGroupProps = {
  children: ReactNode;
  className?: string;
};

export const GanttFeatureListGroup: FC<GanttFeatureListGroupProps> = ({
  children,
  className,
}) => (
  <div className={className} style={{ paddingTop: 'var(--gantt-row-height)' }}>
    {children}
  </div>
);

export type GanttFeatureListProps = {
  className?: string;
  children: ReactNode;
};

export const GanttFeatureList: FC<GanttFeatureListProps> = ({ className, children }) => (
  <div
    className={cn('absolute top-0 left-0 h-full w-max space-y-4', className)}
    style={{ marginTop: 'var(--gantt-header-height)' }}
  >
    {children}
  </div>
);

// ── Provider ──────────────────────────────────────────────────────────────

export type GanttProviderProps = {
  range?: Range;
  zoom?: number;
  onAddItem?: (date: Date) => void;
  /** Calendar year the timeline centres on. Jalali year under SHAMSI. */
  anchorYear?: number;
  children: ReactNode;
  className?: string;
};

export const GanttProvider: FC<GanttProviderProps> = ({
  zoom = 100,
  range = 'monthly',
  onAddItem,
  anchorYear,
  children,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const calendar = getCalendar();

  const centreYear = useMemo(() => {
    if (anchorYear !== undefined) return anchorYear;
    const today = todayUtcMs();
    return calendar === 'SHAMSI'
      ? jalaliYearOfUtcMs(today)
      : new Date(today).getUTCFullYear();
  }, [anchorYear, calendar]);

  const [years, setYears] = useState<number[]>(() => [
    centreYear - 1,
    centreYear,
    centreYear + 1,
  ]);

  // A calendar switch or a new anchor rebuilds the window from scratch;
  // keeping the old Gregorian years around would mislabel every column.
  useEffect(() => {
    setYears([centreYear - 1, centreYear, centreYear + 1]);
  }, [centreYear, calendar, range]);

  const [, setScrollX] = useGanttScrollX();

  const columns = useMemo(
    () => buildGanttColumns(range, years, calendar),
    [range, years, calendar],
  );

  const headerHeight = 60;
  const rowHeight = 36;
  const columnWidth = BASE_COLUMN_WIDTH[range];
  const colW = (zoom / 100) * columnWidth;

  // Upstream read this straight off scrollRef during render, which is null on
  // the first pass — so --gantt-sidebar-width stuck at 0 and the sidebar grid
  // column collapsed under the timeline. Detect after commit instead; the
  // setState is idempotent, so the un-deped effect settles in one extra pass.
  const [hasSidebar, setHasSidebar] = useState(false);
  useLayoutEffect(() => {
    setHasSidebar(
      Boolean(scrollRef.current?.querySelector('[data-roadmap-ui="gantt-sidebar"]')),
    );
  }, [children]);
  const sidebarWidth = hasSidebar ? 300 : 0;

  const cssVariables = {
    '--gantt-zoom': `${zoom}`,
    '--gantt-column-width': `${colW}px`,
    '--gantt-header-height': `${headerHeight}px`,
    '--gantt-row-height': `${rowHeight}px`,
    '--gantt-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  // Centre the viewport on the anchor year whenever the axis is rebuilt.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollLeft =
      scrollRef.current.scrollWidth / 2 - scrollRef.current.clientWidth / 2;
    setScrollX(scrollRef.current.scrollLeft);
  }, [range, zoom, columns.length, setScrollX]);

  const handleScroll = useMemo(
    () =>
      throttle(() => {
        const el = scrollRef.current;
        if (!el) return;
        const { scrollLeft, scrollWidth, clientWidth } = el;
        setScrollX(scrollLeft);

        if (scrollLeft === 0) {
          setYears((prev) => [prev[0] - 1, ...prev]);
          // Nudge off the edge so the next frame doesn't re-trigger.
          el.scrollLeft = el.clientWidth;
          setScrollX(el.scrollLeft);
        } else if (scrollLeft + clientWidth >= scrollWidth) {
          setYears((prev) => [...prev, prev[prev.length - 1] + 1]);
          el.scrollLeft = el.scrollWidth - el.clientWidth;
          setScrollX(el.scrollLeft);
        }
      }, 100),
    [setScrollX],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll);
    return () => {
      el.removeEventListener('scroll', handleScroll);
      handleScroll.cancel();
    };
  }, [handleScroll]);

  return (
    <GanttContext.Provider
      value={{
        zoom,
        range,
        headerHeight,
        columnWidth,
        colW,
        sidebarWidth,
        rowHeight,
        onAddItem,
        columns,
        calendar,
        ref: scrollRef,
      }}
    >
      <div
        // The timeline is a left-to-right number line; mirroring it under RTL
        // would invert every offset. Text inside opts back in with dir="auto".
        dir="ltr"
        className={cn(
          'gantt relative grid h-full w-full flex-none select-none overflow-auto rounded-sm bg-bg-elevated',
          range,
          className,
        )}
        style={{ ...cssVariables, gridTemplateColumns: 'var(--gantt-sidebar-width) 1fr' }}
        ref={scrollRef}
      >
        {children}
      </div>
    </GanttContext.Provider>
  );
};

export type GanttTimelineProps = {
  children: ReactNode;
  className?: string;
};

export const GanttTimeline: FC<GanttTimelineProps> = ({ children, className }) => (
  <div className={cn('relative flex h-full w-max flex-none overflow-clip', className)}>
    {children}
  </div>
);
