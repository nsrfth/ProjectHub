// v2.5.47: collapsible desktop side rail.
//
// Client-only persistence — this is a pure UI preference with no server-side
// meaning, so it follows the same module-singleton + localStorage pattern as
// lib/theme.ts (key `taskhub.sidebar.collapsed`) rather than a DB column.
// Reactivity is provided via useSyncExternalStore so the three consumers
// (LeftSidebar rail, TopNav header offset, ProtectedRoute main offset) all
// re-render in lockstep when the state changes.
//
// Two inputs combine into the *effective* collapsed state:
//   - `_userCollapsed`  the explicit user choice, persisted + synced across tabs
//   - `_forced`         viewport is in the tablet band [md, lg) → auto-collapse
// Effective collapsed = _forced || _userCollapsed. Below md the rail is a
// drawer (see LeftSidebar) and the collapsed styling is gated behind `md:`
// utilities, so `_forced` only matters on the md–lg tablet band.

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'taskhub.sidebar.collapsed';

// lg breakpoint (1024px) is our "desktop" threshold: at/above it the user's
// explicit choice wins and the rail defaults to expanded; below it (but at or
// above md, where the rail is still a rail and not a drawer) we force-collapse.
const AUTO_COLLAPSE_QUERY = '(max-width: 1023px)';

function readStored(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    // private-mode Safari
    return false;
  }
}

function readForced(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(AUTO_COLLAPSE_QUERY).matches;
}

let _userCollapsed = readStored();
let _forced = readForced();
let _snapshot = _forced || _userCollapsed;

const listeners = new Set<() => void>();

function recompute(): void {
  const next = _forced || _userCollapsed;
  if (next !== _snapshot) {
    _snapshot = next;
    listeners.forEach((l) => l());
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Viewport → auto-collapse on the tablet band.
  const mql =
    typeof window !== 'undefined' ? window.matchMedia(AUTO_COLLAPSE_QUERY) : null;
  const onViewport = (e: MediaQueryListEvent): void => {
    _forced = e.matches;
    recompute();
  };
  mql?.addEventListener('change', onViewport);

  // Cross-tab sync of the explicit user choice.
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== STORAGE_KEY) return;
    _userCollapsed = e.newValue === '1';
    recompute();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    mql?.removeEventListener('change', onViewport);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function getSnapshot(): boolean {
  return _snapshot;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Effective collapsed state (user choice OR forced by a tablet viewport). */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Flip the explicit user preference relative to the current effective state. */
export function toggleSidebar(): void {
  setSidebarCollapsed(!_snapshot);
}

export function setSidebarCollapsed(collapsed: boolean): void {
  _userCollapsed = collapsed;
  try {
    window.localStorage?.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // private-mode Safari — state still lives in memory for this session.
  }
  recompute();
}
