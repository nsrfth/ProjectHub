import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import fa from '../../i18n/fa.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tasksPage = readFileSync(join(__dirname, '../../pages/TasksPage.tsx'), 'utf8');

const SUBTASK_I18N = [
  'tasks.subtasks.count',
  'tasks.subtasks.toggle',
  'tasks.subtasks.done',
  'tasks.subtasks.open',
] as const;

describe('Task list subtasks disclosure', () => {
  it('defines subtask i18n keys in EN and FA', () => {
    for (const key of SUBTASK_I18N) {
      expect(en[key as keyof typeof en], `en missing ${key}`).toBeTruthy();
      expect(fa[key as keyof typeof fa], `fa missing ${key}`).toBeTruthy();
    }
  });

  it('defaults collapsed and keeps expand state in memory only', () => {
    expect(tasksPage).toContain('useState<Set<string>>(() => new Set())');
    expect(tasksPage).toContain('toggleExpandedTaskIds');
    expect(tasksPage).not.toMatch(/localStorage.*subtask/i);
    expect(tasksPage).not.toMatch(/subtask.*localStorage/i);
  });

  it('shows disclosure only when subtasks exist and uses logical RTL-safe indent', () => {
    expect(tasksPage).toContain('subtasks.length > 0');
    expect(tasksPage).toContain('ps-8');
    expect(tasksPage).not.toContain('pl-8');
    expect(tasksPage).toContain('rtl:rotate-180');
  });

  it('leaves kanban and technician views unchanged', () => {
    expect(tasksPage).toContain("viewMode === 'status'");
    expect(tasksPage).toContain('<GroupedBoard');
    expect(tasksPage).toContain("viewMode === 'technician'");

    const taskListStart = tasksPage.indexOf('function TaskList');
    const taskListEnd = tasksPage.indexOf('function SubtaskChevron');
    expect(taskListStart).toBeGreaterThan(-1);
    expect(taskListEnd).toBeGreaterThan(taskListStart);

    const outsideTaskList =
      tasksPage.slice(0, taskListStart) + tasksPage.slice(taskListEnd);
    expect(outsideTaskList).not.toContain('expandedTaskIds');
    expect(outsideTaskList).not.toContain('tasks.subtasks.toggle');
  });
});
