import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getLanguage } from '@/lib/i18n';

// v1.10.1: in-app renderer for the canonical USER_MANUAL.md (and its
// Persian sibling, v1.13). The .md files live at the repo root and are
// copied into /public on every build (scripts/copy-manual.mjs). At
// runtime we fetch the one that matches the active language and render
// with ReactMarkdown + GFM (so tables + checklists + autolinks look right).
//
// Fallback: if the language-specific manual 404s (e.g. Persian build
// without the FA file), retry with the English copy so the page is
// never empty.

function manualUrlFor(lang: ReturnType<typeof getLanguage>): string {
  return lang === 'FA' ? '/USER_MANUAL.fa.md' : '/USER_MANUAL.md';
}

export default function HelpPage(): JSX.Element {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lang = getLanguage();

  useEffect(() => {
    let cancelled = false;
    const primary = manualUrlFor(lang);
    const fallback = '/USER_MANUAL.md';
    // Cache-bust on each load so a redeployed manual is picked up
    // immediately. The file is tiny so the bandwidth cost is negligible.
    fetch(`${primary}?v=${Date.now()}`, { cache: 'no-store' })
      .then((res) => {
        if (res.ok) return res.text();
        // Try the EN fallback if the localised file isn't there.
        if (primary !== fallback) {
          return fetch(`${fallback}?v=${Date.now()}`, { cache: 'no-store' }).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
          });
        }
        throw new Error(`HTTP ${res.status}`);
      })
      .then((text) => { if (!cancelled) setMarkdown(text); })
      .catch((err: unknown) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [lang]);

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6 flex items-center justify-end">
        <a
          href={manualUrlFor(lang)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-slate-500 underline"
        >
          Open raw markdown
        </a>
      </div>

      {!markdown && !error && (
        <p className="text-sm text-slate-500">Loading manual…</p>
      )}

      {error && (
        <p className="text-sm text-red-600">
          Could not load the manual: {error}. Ask your operator to rebuild
          the frontend with <code>npm run sync-manual && npm run build</code>.
        </p>
      )}

      {markdown && (
        // Tailwind doesn't ship a typography preset here, so a few base
        // styles inline keep the rendered manual readable without pulling
        // in @tailwindcss/typography just for this page.
        <article className="prose-like text-slate-800">
          <style>{`
            .prose-like h1 { font-size: 1.875rem; font-weight: 700; margin: 1.5rem 0 1rem; }
            .prose-like h2 { font-size: 1.5rem; font-weight: 600; margin: 2rem 0 0.75rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem; }
            .prose-like h3 { font-size: 1.125rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
            .prose-like p { margin: 0.75rem 0; line-height: 1.6; }
            .prose-like ul { list-style: disc; margin: 0.75rem 0; padding-left: 1.5rem; }
            .prose-like ol { list-style: decimal; margin: 0.75rem 0; padding-left: 1.5rem; }
            .prose-like li { margin: 0.25rem 0; line-height: 1.5; }
            .prose-like a { color: #1e293b; text-decoration: underline; }
            .prose-like code { background: #f1f5f9; padding: 0.1rem 0.35rem; border-radius: 0.25rem; font-size: 0.85em; }
            .prose-like pre { background: #f1f5f9; padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; margin: 1rem 0; }
            .prose-like pre code { background: transparent; padding: 0; }
            .prose-like table { border-collapse: collapse; margin: 1rem 0; font-size: 0.875rem; }
            .prose-like th, .prose-like td { border: 1px solid #e2e8f0; padding: 0.4rem 0.75rem; text-align: left; vertical-align: top; }
            .prose-like th { background: #f8fafc; font-weight: 600; }
            .prose-like blockquote { border-left: 3px solid #cbd5e1; padding: 0.25rem 1rem; margin: 1rem 0; color: #475569; }
            .prose-like hr { border: 0; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
            .prose-like strong { font-weight: 600; }
          `}</style>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}
