import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const topNavSrc = readFileSync(resolve(__dirname, 'TopNav.tsx'), 'utf8');
const tasksPageSrc = readFileSync(resolve(__dirname, '../../pages/TasksPage.tsx'), 'utf8');

describe('TopNav', () => {
  it('does not render the top-bar New Task button', () => {
    expect(topNavSrc).not.toContain('newTaskHref');
    expect(topNavSrc).not.toContain("dashboard.newTask");
    expect(topNavSrc).not.toMatch(/<Link[^>]*>[\s\S]*New task/i);
  });

  it('keeps notification bell, user menu, search, title, and mobile menu', () => {
    expect(topNavSrc).toContain('<NotificationBell />');
    expect(topNavSrc).toContain('<UserMenu />');
    expect(topNavSrc).toContain('<SearchInput />');
    expect(topNavSrc).toContain('<IconMenu');
    expect(topNavSrc).toContain('titleKeyFor');
  });

  it('does not import Link when only used for the removed control', () => {
    expect(topNavSrc).not.toMatch(/import \{[^}]*\bLink\b/);
  });
});

describe('TasksPage task creation', () => {
  it('still exposes create-task via tasksApi.createTask', () => {
    expect(tasksPageSrc).toContain('tasksApi.createTask');
  });
});
