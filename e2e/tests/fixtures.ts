import { test as base, type Page, expect } from '@playwright/test';

export const STATE_FILE = '.auth/user.json';

export function credentials(): { email: string; password: string } {
  return {
    email: process.env.E2E_EMAIL ?? 'admin@taskhub.local',
    password: process.env.E2E_PASSWORD ?? 'admin',
  };
}

/**
 * A unique-per-run suffix so repeated runs against a long-lived staging stack
 * don't collide on names or leave ambiguous fixtures behind.
 */
export function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The app remembers view modes in localStorage, and each mode renders a
 * completely different DOM:
 *
 *   'projects.viewMode'  'all' | 'buckets'                  (features/projectBuckets/storage.ts)
 *   'kanban.viewMode'    'status' | 'list' | 'responsible'  (pages/TasksPage.tsx)
 *
 * Left alone, a previous run — or a human using the same staging account —
 * can leave the app in a mode where this suite's selectors match nothing, and
 * the failure reads as "element not found" rather than "wrong view".
 *
 * 'projects.selectedTeam' is cleared for the same reason: a remembered team
 * filter hides projects belonging to other teams, so the list can be
 * legitimately rendered and still not contain the project we just created.
 *
 * These key names are duplicated from the frontend rather than imported, since
 * this package doesn't build against src/. If they change, this goes stale
 * silently — which is why the projects spec asserts the list rendered and
 * contains our own fixture, instead of trusting the mode was applied.
 */
async function pinViewModes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('projects.viewMode', 'all');
      window.localStorage.setItem('kanban.viewMode', 'list');
      window.localStorage.removeItem('projects.selectedTeam');
    } catch {
      // Private-mode storage failures must not abort the run.
    }
  });
}

export const test = base.extend<{ appPage: Page }>({
  appPage: async ({ page }, use) => {
    // Every destructive control in this app goes through window.confirm().
    // Without a handler, Playwright leaves the dialog open and the click never
    // resolves — the test hangs to timeout instead of failing usefully.
    page.on('dialog', (d) => {
      void d.accept();
    });

    await pinViewModes(page);
    await use(page);
  },
});

export { expect };
