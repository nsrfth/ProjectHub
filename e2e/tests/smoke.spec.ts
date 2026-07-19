import { test, expect } from './fixtures.js';

// The five-flow smoke suite (Phase 0b).
//
// Scope discipline: these are the flows whose breakage makes the product
// unusable. Everything else belongs in the backend integration suite, which is
// faster, more precise, and already comprehensive. The job of this file is to
// prove the app still works end to end after a Phase 2 access-resolver flag
// transition — not to re-test business logic through a browser.
//
// Flows 2-5 chain deliberately: the project created in flow 2 is the one
// opened in flow 3, worked in flow 4, and shared in flow 5. A fresh fixture
// per test would be more isolated, but the chain is what proves the objects
// survive a round trip through the API — and an orphaned project per run
// against a long-lived staging stack is real litter.

test.describe.configure({ mode: 'serial' });

let projectName: string;
let projectId: string;

test('1 — the dashboard loads for an authenticated user', async ({ appPage: page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);

  // ProtectedRoute renders null while the auth refresh is in flight, so a
  // "page has content" check races it. Assert we were NOT bounced to /login —
  // that is the real signal that the stored refresh cookie still works.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('2 — the project list renders and a project can be created', async ({ appPage: page }) => {
  await page.goto('/projects');
  await expect(page.getByTestId('projects-list')).toBeVisible();

  const before = await page.getByTestId('project-row').count();

  projectName = `e2e smoke ${Date.now().toString(36)}`;
  await page.getByTestId('projects-new').click();

  // Every modal in the app is the shared Modal component.
  const dialog = page.locator('.dialog-panel');
  await expect(dialog).toBeVisible();

  // The create form's name field is the first required text input in the
  // dialog; the form is otherwise all optional metadata.
  await dialog.locator('input[type="text"]').first().fill(projectName);
  await dialog.locator('button[type="submit"]').click();

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('project-row')).toHaveCount(before + 1);

  const row = page.getByTestId('project-row').filter({ hasText: projectName });
  await expect(row).toHaveCount(1);
  projectId = (await row.getAttribute('data-project-id')) ?? '';
  expect(projectId).not.toBe('');
});

test('3 — opening a project navigates to its task page', async ({ appPage: page }) => {
  await page.goto('/projects');
  const row = page.getByTestId('project-row').filter({ hasText: projectName });
  await row.getByTestId('project-open').click();

  // There is no /projects/:id route — the de-facto detail page is the task list.
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks`));
  await expect(page.getByTestId('task-create-title')).toBeVisible();
});

test('4 — a task can be created, restatused, and deleted', async ({ appPage: page }) => {
  await page.goto(`/projects/${projectId}/tasks`);

  const taskTitle = `smoke task ${Date.now().toString(36)}`;
  await page.getByTestId('task-create-title').fill(taskTitle);
  await page.getByTestId('task-create-submit').click();

  const row = page.getByTestId('task-row').filter({ hasText: taskTitle });
  await expect(row).toHaveCount(1);

  // aria-label="Status" is hardcoded English rather than i18n'd, so it is
  // stable today. The option VALUES are the real contract either way.
  await row.locator('select[aria-label="Status"]').selectOption('IN_PROGRESS');
  await expect(row.locator('select[aria-label="Status"]')).toHaveValue('IN_PROGRESS');

  // The delete confirm() is auto-accepted by the dialog handler in fixtures.ts.
  await row.locator('button[aria-label="Delete task"]').click();
  await expect(page.getByTestId('task-row').filter({ hasText: taskTitle })).toHaveCount(0);
});

test('5 — the sharing panel opens from the project actions menu', async ({ appPage: page }) => {
  await page.goto('/projects');
  const row = page.getByTestId('project-row').filter({ hasText: projectName });

  // aria-haspopup is the only stable hook on the ⋯ trigger; its aria-label is
  // an i18n string. The menu only renders for users who can manage the project.
  const trigger = row.locator('button[aria-haspopup="menu"]');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  // Edit is menuitem index 0. All four items share a className and differ only
  // by translated text, so position is genuinely the only discriminator.
  await menu.getByRole('menuitem').first().click();

  const dialog = page.locator('.dialog-panel');
  await expect(dialog).toBeVisible();

  // ProjectTeamSharesPanel renders only for a global ADMIN. Assert the modal
  // opened either way, and check the panel only when the account can see it —
  // a smoke suite that demands ADMIN would fail for a legitimate reason and
  // report it as a broken sharing panel.
  const sharesSelects = dialog.locator('select.input');
  if ((await sharesSelects.count()) > 0) {
    await expect(sharesSelects.first()).toBeVisible();
  }

  await dialog.locator('button[aria-label="Close"]').click();
  await expect(dialog).toBeHidden();
});

test.afterAll(async ({ browser }) => {
  // Clean up the fixture project so repeated runs against a long-lived staging
  // stack don't accumulate litter. Best-effort: a failed cleanup must not turn
  // a green suite red.
  if (!projectName) return;
  const page = await browser.newPage({ storageState: '.auth/user.json' });
  page.on('dialog', (d) => void d.accept());
  try {
    await page.goto('/projects');
    const row = page.getByTestId('project-row').filter({ hasText: projectName });
    if ((await row.count()) === 0) return;
    await row.locator('button[aria-haspopup="menu"]').click();
    const items = page.locator('[role="menu"] [role="menuitem"]');
    await items.last().click(); // delete is the last item
  } catch {
    // Ignore — cleanup is courtesy, not a test.
  } finally {
    await page.close();
  }
});
