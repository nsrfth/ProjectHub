import type { TimelineZoom } from './types';

export const SIDEBAR_WIDTH = 280;
export const ROW_HEIGHT = 36;
export const HEADER_HEIGHT = 44;
export const VIRTUAL_BUFFER_ROWS = 8;

export function pxPerDay(zoom: TimelineZoom): number {
  switch (zoom) {
    case 'day':
      return 40;
    case 'week':
      return 28;
    case 'month':
      return 6;
  }
}

/** Number of calendar days in the visible axis for each zoom level. */
export function visibleDayCount(zoom: TimelineZoom): number {
  switch (zoom) {
    case 'day':
      return 21;
    case 'week':
      return 56;
    case 'month':
      return 180;
  }
}

/** Navigation step when clicking prev/next. */
export function navStepDays(zoom: TimelineZoom): number {
  switch (zoom) {
    case 'day':
      return 7;
    case 'week':
      return 14;
    case 'month':
      return 30;
  }
}
