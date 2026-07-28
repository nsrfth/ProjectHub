import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn-convention `cn`. v2.22 swapped the earlier plain join for the real
// twMerge(clsx(...)) once clsx + tailwind-merge arrived with the Gantt. The
// Gantt leans on `cn` for caller className overrides — a marker passing
// `bg-primary` over the default `bg-surface`, say — and a plain join emits
// both classes and lets stylesheet order decide, silently dropping the
// override. twMerge resolves the conflict in the caller's favour.

export type { ClassValue };

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
