import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(__dirname, '../..');

const KEYS = [
  'reports.budget.title',
  'reports.budget.planned',
  'reports.budget.actual',
  'reports.budget.variance',
  'reports.budget.utilization',
  'reports.budget.overBudget',
  'reports.budget.rollup',
  'reports.budget.noBudget',
];

describe('Budget report i18n', () => {
  it('defines budget report keys in EN and FA catalogues', () => {
    for (const file of ['i18n/en.json', 'i18n/fa.json']) {
      const cat = readFileSync(join(frontendRoot, file), 'utf8');
      for (const key of KEYS) {
        expect(cat, `${file} missing ${key}`).toContain(`"${key}"`);
      }
    }
  });

  it('ReportsPage uses budget API and RTL-safe money columns', () => {
    const src = readFileSync(join(frontendRoot, 'pages/ReportsPage.tsx'), 'utf8');
    expect(src).toContain('fetchBudgetReport');
    expect(src).toContain("downloadReportCsv(currentTeam.id, 'budget'");
    expect(src).toContain('dir="ltr"');
    expect(src).toContain("t('reports.budget.title')");
  });
});
