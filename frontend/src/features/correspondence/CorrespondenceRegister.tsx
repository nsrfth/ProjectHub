import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import * as corrApi from './api';
import { LetterEditor } from './LetterEditor';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

interface CorrespondenceRegisterProps {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

const DIRECTION_BADGE: Record<corrApi.LetterDirection, string> = {
  INCOMING: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  OUTGOING: 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200',
  INTERNAL: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

const STATUS_BADGE: Record<corrApi.LetterStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  SENT: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  RECEIVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  ARCHIVED: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

export function CorrespondenceRegister({
  teamId,
  projectId,
  canManage,
}: CorrespondenceRegisterProps): JSX.Element {
  const t = useT();

  const [direction, setDirection] = useState<corrApi.LetterDirection | ''>('');
  const [status, setStatus] = useState<corrApi.LetterStatus | ''>('');
  const [search, setSearch] = useState('');
  // null when closed; { letter } open (letter null → create).
  const [editing, setEditing] = useState<{ letter: corrApi.Letter | null } | null>(null);

  const filters: corrApi.LetterFilters = { direction, status, search: search.trim() || undefined };

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['correspondence', teamId, projectId, filters],
    queryFn: ({ pageParam }) =>
      corrApi.listLetters(teamId, projectId, { ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!teamId && !!projectId,
  });
  const letters = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder={t('correspondence.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border-border px-3 py-1.5 border text-sm dark:bg-slate-800 min-w-[14rem]"
        />
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as corrApi.LetterDirection | '')}
          className="rounded border-border px-2 py-1.5 border text-sm dark:bg-slate-800"
        >
          <option value="">{t('correspondence.filter.allDirections')}</option>
          <option value="INCOMING">{t('correspondence.direction.INCOMING')}</option>
          <option value="OUTGOING">{t('correspondence.direction.OUTGOING')}</option>
          <option value="INTERNAL">{t('correspondence.direction.INTERNAL')}</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as corrApi.LetterStatus | '')}
          className="rounded border-border px-2 py-1.5 border text-sm dark:bg-slate-800"
        >
          <option value="">{t('correspondence.filter.allStatuses')}</option>
          <option value="DRAFT">{t('correspondence.status.DRAFT')}</option>
          <option value="SENT">{t('correspondence.status.SENT')}</option>
          <option value="RECEIVED">{t('correspondence.status.RECEIVED')}</option>
          <option value="ARCHIVED">{t('correspondence.status.ARCHIVED')}</option>
        </select>
        {canManage && (
          <button
            type="button"
            onClick={() => setEditing({ letter: null })}
            className="ms-auto rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
          >
            {t('correspondence.new')}
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : letters.length === 0 ? (
        <p className="text-sm text-slate-500 italic">{t('correspondence.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-muted">
              <tr className="text-start">
                <Th>{t('correspondence.col.referenceNumber')}</Th>
                <Th>{t('correspondence.col.subject')}</Th>
                <Th>{t('correspondence.col.direction')}</Th>
                <Th>{t('correspondence.col.letterDate')}</Th>
                <Th>{t('correspondence.col.sender')}</Th>
                <Th>{t('correspondence.col.recipient')}</Th>
                <Th>{t('correspondence.col.status')}</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {letters.map((l) => (
                <tr
                  key={l.id}
                  className="hover:bg-bg-elevated cursor-pointer"
                  onClick={() => setEditing({ letter: l })}
                >
                  <td className="px-3 py-2 font-mono" dir="ltr">{l.referenceNumber}</td>
                  <td className="px-3 py-2 max-w-[16rem] truncate">{l.subject}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[11px] rounded-full px-2 py-0.5 ${DIRECTION_BADGE[l.direction]}`}>
                      {t(`correspondence.direction.${l.direction}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" dir="rtl">
                    {formatShamsiCalendarDate(l.letterDate) ?? '—'}
                  </td>
                  <td className="px-3 py-2 truncate">{l.senderName ?? '—'}</td>
                  <td className="px-3 py-2 truncate">{l.recipientName ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[11px] rounded-full px-2 py-0.5 ${STATUS_BADGE[l.status]}`}>
                      {t(`correspondence.status.${l.status}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-end whitespace-nowrap">
                    {l.replyTo && (
                      <span
                        title={`${t('correspondence.field.inReplyTo')}: ${l.replyTo.referenceNumber}`}
                        className="me-2"
                      >
                        ↩
                      </span>
                    )}
                    {l.linkedTasks.length > 0 && (
                      <span title={t('correspondence.linkedTasks.title')} className="me-2">
                        ✔ {l.linkedTasks.length}
                      </span>
                    )}
                    {l.attachmentCount > 0 && (
                      <span title={t('correspondence.attachments.title')} className="me-2">
                        📎 {l.attachmentCount}
                      </span>
                    )}
                    {l.hasReferrals && (
                      <span title={t('correspondence.referral.title')}>↪</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-md border border-border px-4 py-1.5 text-sm hover:bg-bg-elevated disabled:opacity-50"
          >
            {isFetchingNextPage ? t('common.loading') : t('correspondence.loadMore')}
          </button>
        </div>
      )}

      {editing && (
        <LetterEditor
          teamId={teamId}
          projectId={projectId}
          letter={editing.letter}
          canManage={canManage}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }): JSX.Element {
  return <th className="px-3 py-2 text-start font-medium uppercase tracking-wide text-[11px]">{children}</th>;
}
