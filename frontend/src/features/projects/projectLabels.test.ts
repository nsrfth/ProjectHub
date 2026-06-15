import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const listRow = readFileSync(join(__dirname, 'ProjectListRow.tsx'), 'utf8');
const api = readFileSync(join(__dirname, 'api.ts'), 'utf8');

describe('project labels defensive handling', () => {
  it('ProjectListRow does not read .labels.length without optional chaining', () => {
    expect(listRow).not.toMatch(/project\.labels\.length/);
    expect(listRow).toContain('project.labels?.length');
  });

  it('listAllProjects normalizes missing labels to []', () => {
    expect(api).toContain('labels: p.labels ?? []');
    expect(api).toContain('normalizeProject');
  });
});
