import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  searchAll,
  type CommentHit,
  type ProjectHit,
  type SearchResults,
  type TaskHit,
} from '@/features/search/api';
import { useT } from '@/lib/i18n';

// v1.30: search results page. Reads `?q=<query>` from the URL and renders
// three buckets (tasks / comments / projects), each with its own
// "Load more" button driven by per-bucket cursors.
//
// We accumulate paginated rows in local state per bucket so the user can
// keep clicking "Load more" without losing scroll position. Each "Load
// more" issues a fresh searchAll call with that bucket's cursor + only
// that bucket's `type` filter, so the other two buckets aren't refetched.

const STATUS_LABEL: Record<TaskHit['status'], string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  DONE: 'Done',
};

interface BucketState<T> {
  items: T[];
  nextCursor: string | null;
}

export default function SearchPage(): JSX.Element {
  const t = useT();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();

  // Local accumulators per bucket — seeded by the initial useQuery, then
  // appended via "Load more". Resetting them when `q` changes is handled
  // by the queryKey-driven re-fetch + the `useState` initializer below.
  const initialState: {
    tasks: BucketState<TaskHit>;
    comments: BucketState<CommentHit>;
    projects: BucketState<ProjectHit>;
  } = {
    tasks: { items: [], nextCursor: null },
    comments: { items: [], nextCursor: null },
    projects: { items: [], nextCursor: null },
  };

  // We key the local state by the current `q` so a new search clears the
  // accumulators without a useEffect.
  const [state, setState] = useState<{
    q: string;
    tasks: BucketState<TaskHit>;
    comments: BucketState<CommentHit>;
    projects: BucketState<ProjectHit>;
  }>({ q: '', ...initialState });
  if (state.q !== q) {
    setState({ q, ...initialState });
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['search', q],
    queryFn: () => searchAll({ q }),
    enabled: q.length > 0,
  });

  // On first successful response, seed the local accumulators.
  if (data && state.tasks.items.length === 0 && data.tasks.items.length > 0) {
    setState((s) => ({ ...s, tasks: data.tasks }));
  }
  if (data && state.comments.items.length === 0 && data.comments.items.length > 0) {
    setState((s) => ({ ...s, comments: data.comments }));
  }
  if (data && state.projects.items.length === 0 && data.projects.items.length > 0) {
    setState((s) => ({ ...s, projects: data.projects }));
  }
  // First-load cursors (when the bucket has rows; the seed above carries
  // them along). When the initial response is empty, ensure cursors stay
  // null.
  const tasksBucket: BucketState<TaskHit> = state.tasks.items.length
    ? state.tasks
    : data?.tasks ?? state.tasks;
  const commentsBucket: BucketState<CommentHit> = state.comments.items.length
    ? state.comments
    : data?.comments ?? state.comments;
  const projectsBucket: BucketState<ProjectHit> = state.projects.items.length
    ? state.projects
    : data?.projects ?? state.projects;

  async function loadMore(kind: 'task' | 'comment' | 'project'): Promise<void> {
    const cursor =
      kind === 'task'
        ? tasksBucket.nextCursor
        : kind === 'comment'
          ? commentsBucket.nextCursor
          : projectsBucket.nextCursor;
    if (!cursor) return;
    const more: SearchResults = await searchAll({
      q,
      type: kind,
      ...(kind === 'task' && { taskCursor: cursor }),
      ...(kind === 'comment' && { commentCursor: cursor }),
      ...(kind === 'project' && { projectCursor: cursor }),
    });
    setState((s) =>
      kind === 'task'
        ? { ...s, tasks: { items: [...s.tasks.items, ...more.tasks.items], nextCursor: more.tasks.nextCursor } }
        : kind === 'comment'
          ? {
              ...s,
              comments: {
                items: [...s.comments.items, ...more.comments.items],
                nextCursor: more.comments.nextCursor,
              },
            }
          : {
              ...s,
              projects: {
                items: [...s.projects.items, ...more.projects.items],
                nextCursor: more.projects.nextCursor,
              },
            },
    );
  }

  const totalHits =
    tasksBucket.items.length + commentsBucket.items.length + projectsBucket.items.length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-2">{t('search.title')}</h1>
      {q ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          {t('search.resultsFor').replace('{q}', q)}
        </p>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          {t('search.hint')}
        </p>
      )}

      {q && isLoading && <p className="text-sm text-slate-400">{t('search.loading')}</p>}
      {error && <p className="text-sm text-red-600">{t('search.error')}</p>}

      {q && !isLoading && !error && totalHits === 0 && (
        <p className="text-sm text-slate-500 italic">{t('search.noResults')}</p>
      )}

      {q && totalHits > 0 && (
        <div className="space-y-6">
          <Section
            title={t('search.tasks')}
            bucket={tasksBucket}
            onLoadMore={() => loadMore('task')}
            loadMoreLabel={t('search.loadMore')}
            renderItem={(hit) => <TaskRow hit={hit} />}
          />
          <Section
            title={t('search.comments')}
            bucket={commentsBucket}
            onLoadMore={() => loadMore('comment')}
            loadMoreLabel={t('search.loadMore')}
            renderItem={(hit) => <CommentRow hit={hit} />}
          />
          <Section
            title={t('search.projects')}
            bucket={projectsBucket}
            onLoadMore={() => loadMore('project')}
            loadMoreLabel={t('search.loadMore')}
            renderItem={(hit) => <ProjectRow hit={hit} />}
          />
        </div>
      )}
    </div>
  );
}

function Section<T extends { id: string }>({
  title,
  bucket,
  onLoadMore,
  loadMoreLabel,
  renderItem,
}: {
  title: string;
  bucket: BucketState<T>;
  onLoadMore: () => void;
  loadMoreLabel: string;
  renderItem: (item: T) => React.ReactNode;
}): JSX.Element | null {
  if (bucket.items.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500 mb-2">
        {title} <span className="text-slate-400">({bucket.items.length})</span>
      </h2>
      <ul className="space-y-2">
        {bucket.items.map((item) => (
          <li
            key={item.id}
            className="bg-white dark:bg-slate-800 rounded shadow px-4 py-3"
          >
            {renderItem(item)}
          </li>
        ))}
      </ul>
      {bucket.nextCursor && (
        <button
          type="button"
          onClick={onLoadMore}
          className="mt-2 text-xs underline text-slate-600 dark:text-slate-300"
        >
          {loadMoreLabel}
        </button>
      )}
    </section>
  );
}

// `ts_headline` returns HTML-escaped text with literal <b>...</b> markers
// for the matches. Strip everything except those bold tags before rendering.
function sanitiseExcerpt(html: string): string {
  // Drop any tag that isn't <b> or </b>.
  return html.replace(/<(?!\/?b>)[^>]*>/gi, '');
}

function Excerpt({ html }: { html: string | null }): JSX.Element | null {
  if (!html) return null;
  return (
    <p
      className="text-sm text-slate-600 dark:text-slate-300 mt-1"
      // sanitiseExcerpt strips everything except <b>/</b> from ts_headline
      // output; the surrounding text was already HTML-escaped by Postgres.
      dangerouslySetInnerHTML={{ __html: sanitiseExcerpt(html) }}
    />
  );
}

function TaskRow({ hit }: { hit: TaskHit }): JSX.Element {
  return (
    <Link
      to={`/projects/${hit.projectId}/tasks/${hit.id}`}
      className="block hover:bg-slate-50 dark:hover:bg-slate-700/50 -mx-4 -my-3 px-4 py-3 rounded"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium">{hit.title}</span>
        <span className="text-[11px] uppercase tracking-wide text-slate-500 shrink-0">
          {STATUS_LABEL[hit.status]}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 mt-0.5">
        {hit.teamName} · {hit.projectName}
      </p>
      <Excerpt html={hit.excerpt} />
    </Link>
  );
}

function CommentRow({ hit }: { hit: CommentHit }): JSX.Element {
  return (
    <Link
      to={`/projects/${hit.projectId}/tasks/${hit.taskId}`}
      className="block hover:bg-slate-50 dark:hover:bg-slate-700/50 -mx-4 -my-3 px-4 py-3 rounded"
    >
      <div className="text-sm font-medium">
        {hit.authorName ?? 'Unknown'} on <span className="underline decoration-slate-300">{hit.taskTitle}</span>
      </div>
      <p className="text-[11px] text-slate-500 mt-0.5">
        {hit.teamName} · {hit.projectName} · {new Date(hit.createdAt).toLocaleString()}
      </p>
      <Excerpt html={hit.excerpt} />
    </Link>
  );
}

function ProjectRow({ hit }: { hit: ProjectHit }): JSX.Element {
  return (
    <Link
      to="/projects"
      className="block hover:bg-slate-50 dark:hover:bg-slate-700/50 -mx-4 -my-3 px-4 py-3 rounded"
    >
      <span className="font-medium">{hit.name}</span>
      <p className="text-[11px] text-slate-500 mt-0.5">{hit.teamName}</p>
      <Excerpt html={hit.excerpt} />
    </Link>
  );
}
