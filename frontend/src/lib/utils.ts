// shadcn-style `cn` helper. The upstream shadcn version is
// `twMerge(clsx(...))`, but this repo doesn't carry clsx or tailwind-merge and
// nothing here relies on conflicting-class resolution — so this is the plain
// join. If a future component genuinely needs class-conflict merging, add
// clsx + tailwind-merge and swap the body; the signature stays the same.

export type ClassValue = string | number | null | undefined | false;

export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}
