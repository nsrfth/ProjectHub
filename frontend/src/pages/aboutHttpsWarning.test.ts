import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldShowHttpsPwaWarning } from './aboutHttpsWarning';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('shouldShowHttpsPwaWarning', () => {
  it('shows for admin on an insecure origin (plain HTTP)', () => {
    expect(shouldShowHttpsPwaWarning(true, false)).toBe(true);
  });

  it('hidden for non-admin on any origin', () => {
    expect(shouldShowHttpsPwaWarning(false, false)).toBe(false);
    expect(shouldShowHttpsPwaWarning(false, true)).toBe(false);
  });

  it('hidden when secure (HTTPS or localhost)', () => {
    expect(shouldShowHttpsPwaWarning(true, true)).toBe(false);
  });
});

describe('AboutPage HTTPS warning wiring', () => {
  const src = readFileSync(join(__dirname, 'AboutPage.tsx'), 'utf8');
  const en = readFileSync(join(__dirname, '../i18n/en.json'), 'utf8');
  const fa = readFileSync(join(__dirname, '../i18n/fa.json'), 'utf8');

  it('AboutPage uses isSecureContext and admin gate', () => {
    expect(src).toContain('shouldShowHttpsPwaWarning');
    expect(src).toContain('isSecureContext');
    expect(src).toContain("user?.globalRole === 'ADMIN'");
    expect(src).toContain('bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200');
  });

  it('warning strings exist in both catalogues', () => {
    for (const cat of [en, fa]) {
      expect(cat).toContain('"about.https.warningTitle"');
      expect(cat).toContain('"about.https.warningBody"');
    }
  });
});
