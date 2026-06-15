import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(__dirname, '..');
const viteConfigSrc = readFileSync(join(frontendRoot, 'vite.config.ts'), 'utf8');
const indexHtml = readFileSync(join(frontendRoot, 'index.html'), 'utf8');

describe('PWA configuration', () => {
  it('vite config registers autoUpdate PWA with API NetworkOnly', () => {
    expect(viteConfigSrc).toContain("registerType: 'autoUpdate'");
    expect(viteConfigSrc).toContain('vite-plugin-pwa');
    expect(viteConfigSrc).toContain("handler: 'NetworkOnly'");
    expect(viteConfigSrc).toContain("url.pathname.startsWith('/api/')");
    expect(viteConfigSrc).toContain("theme_color: '#6366f1'");
    expect(viteConfigSrc).toContain("purpose: 'maskable'");
  });

  it('index.html has theme-color and apple tags without removing favicon bootstrap', () => {
    expect(indexHtml).toContain('name="theme-color" content="#6366f1"');
    expect(indexHtml).toContain('apple-mobile-web-app-capable');
    expect(indexHtml).toContain('/icons/apple-touch-icon.png');
    expect(indexHtml).toContain('taskhub.theme');
    expect(indexHtml).toContain('image/svg+xml');
  });

  it('icon PNGs are generated in public/icons', () => {
    const iconsDir = join(frontendRoot, 'public', 'icons');
    for (const name of [
      'pwa-192.png',
      'pwa-512.png',
      'pwa-512-maskable.png',
      'apple-touch-icon.png',
    ]) {
      expect(existsSync(join(iconsDir, name)), `missing ${name}`).toBe(true);
    }
  });

  it('brand SVG sources match the filled Quad mark', () => {
    const filled = readFileSync(join(frontendRoot, 'scripts/pwa/brand-mark-filled.svg'), 'utf8');
    expect(filled).toContain('#6366f1');
    expect(filled).toContain('19 10.5 21 12.3 24 8.7');
    const maskable = readFileSync(join(frontendRoot, 'scripts/pwa/brand-mark-maskable.svg'), 'utf8');
    expect(maskable).toContain('scale(0.8)');
  });
});
