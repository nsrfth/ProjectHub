import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as corrApi from './api';
import { LetterAttachments } from './LetterAttachments';
import { ReferralPanel } from './ReferralPanel';
import { LinkedTasksPanel } from './LinkedTasksPanel';
import { ContactPicker } from '@/features/contacts/ContactPicker';
import Modal from '@/features/ui/Modal';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { useT } from '@/lib/i18n';

interface LetterEditorProps {
  teamId: string;
  projectId: string;
  // The letter to edit, or null to create a new one.
  letter: corrApi.Letter | null;
  canManage: boolean;
  onClose: () => void;
}

const DIRECTIONS: corrApi.LetterDirection[] = ['INCOMING', 'OUTGOING', 'INTERNAL'];
const STATUSES: corrApi.LetterStatus[] = ['DRAFT', 'SENT', 'RECEIVED', 'ARCHIVED'];

export function LetterEditor({
  teamId,
  projectId,
  letter,
  canManage,
  onClose,
}: LetterEditorProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  // Once saved (or when editing an existing letter), we have an id and can
  // show attachments + referrals.
  const [savedId, setSavedId] = useState<string | null>(letter?.id ?? null);
  const [referenceNumber, setReferenceNumber] = useState<string | null>(
    letter?.referenceNumber ?? null,
  );

  const [subject, setSubject] = useState(letter?.subject ?? '');
  const [body, setBody] = useState(letter?.body ?? '');
  const [direction, setDirection] = useState<corrApi.LetterDirection>(
    letter?.direction ?? 'INCOMING',
  );
  const [letterDate, setLetterDate] = useState<string | null>(letter?.letterDate ?? null);
  const [senderId, setSenderId] = useState<string | null>(letter?.senderId ?? null);
  const [recipientId, setRecipientId] = useState<string | null>(letter?.recipientId ?? null);
  const [status, setStatus] = useState<corrApi.LetterStatus>(letter?.status ?? 'DRAFT');
  // v2.5.26 (W2.2): external correspondent's own ref/date + reply-to thread.
  const [externalReferenceNumber, setExternalReferenceNumber] = useState<string>(
    letter?.externalReferenceNumber ?? '',
  );
  const [externalDate, setExternalDate] = useState<string | null>(letter?.externalDate ?? null);
  const [replyToId, setReplyToId] = useState<string | null>(letter?.replyToId ?? null);
  const [replyTo, setReplyTo] = useState<corrApi.ReplyToSummary | null>(letter?.replyTo ?? null);
  const [formError, setFormError] = useState<string | null>(null);

  const readOnly = !canManage;

  // Candidate parent letters for the reply-to picker (same project, exclude self).
  const { data: allLetters = [] } = useQuery({
    queryKey: ['correspondence', teamId, projectId],
    queryFn: () => corrApi.listLetters(teamId, projectId),
    enabled: canManage,
  });
  const replyCandidates = allLetters.filter((l) => l.id !== savedId);

  function invalidateList(): void {
    void qc.invalidateQueries({ queryKey: ['correspondence', teamId, projectId] });
  }

  const saveMut = useMutation({
    mutationFn: () => {
      const input: corrApi.LetterInput = {
        subject: subject.trim(),
        body,
        direction,
        letterDate,
        senderId,
        recipientId,
        status,
        externalReferenceNumber: externalReferenceNumber.trim() || null,
        externalDate,
        replyToId,
      };
      return savedId
        ? corrApi.updateLetter(teamId, projectId, savedId, input)
        : corrApi.createLetter(teamId, projectId, input);
    },
    onSuccess: async (saved) => {
      setFormError(null);
      setSavedId(saved.id);
      setReferenceNumber(saved.referenceNumber);
      setReplyTo(saved.replyTo);
      invalidateList();
      await qc.invalidateQueries({ queryKey: ['correspondence', 'letter', saved.id] });
    },
    onError: (err) => setFormError(corrApi.errorMessage(err, t('correspondence.editor.saveError'))),
  });

  return (
    <Modal
      title={savedId ? t('correspondence.editor.editTitle') : t('correspondence.editor.newTitle')}
      onClose={onClose}
    >
      <div className="space-y-4">
        {savedId && referenceNumber && (
          <p className="text-xs text-slate-500">
            {t('correspondence.field.referenceNumber')}:{' '}
            <span dir="ltr" className="font-mono">{referenceNumber}</span>
          </p>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!readOnly) saveMut.mutate();
          }}
          className="space-y-3"
        >
          <Field label={t('correspondence.field.subject')}>
            <input
              type="text"
              required
              disabled={readOnly}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800 disabled:opacity-60"
            />
          </Field>

          <Field label={t('correspondence.field.body')}>
            <textarea
              rows={4}
              disabled={readOnly}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800 disabled:opacity-60"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('correspondence.field.direction')}>
              <select
                disabled={readOnly}
                value={direction}
                onChange={(e) => setDirection(e.target.value as corrApi.LetterDirection)}
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800 disabled:opacity-60"
              >
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {t(`correspondence.direction.${d}`)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('correspondence.field.status')}>
              <select
                disabled={readOnly}
                value={status}
                onChange={(e) => setStatus(e.target.value as corrApi.LetterStatus)}
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800 disabled:opacity-60"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`correspondence.status.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('correspondence.field.letterDate')}>
            <ShamsiDatePicker value={letterDate} onChange={setLetterDate} disabled={readOnly} />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('correspondence.field.sender')}>
              <ContactPicker
                teamId={teamId}
                value={senderId}
                onChange={setSenderId}
                canManage={canManage}
                placeholder={t('contacts.none')}
              />
            </Field>
            <Field label={t('correspondence.field.recipient')}>
              <ContactPicker
                teamId={teamId}
                value={recipientId}
                onChange={setRecipientId}
                canManage={canManage}
                placeholder={t('contacts.none')}
              />
            </Field>
          </div>

          {/* v2.5.26 (W2.2): external correspondent's own reference + date. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('correspondence.field.externalReferenceNumber')}>
              <input
                type="text"
                dir="ltr"
                disabled={readOnly}
                value={externalReferenceNumber}
                onChange={(e) => setExternalReferenceNumber(e.target.value)}
                placeholder={t('correspondence.field.externalReferenceNumberHint')}
                className="w-full rounded border-border px-2 py-1 border text-sm font-mono dark:bg-slate-800 disabled:opacity-60"
              />
            </Field>
            <Field label={t('correspondence.field.externalDate')}>
              <ShamsiDatePicker value={externalDate} onChange={setExternalDate} disabled={readOnly} />
            </Field>
          </div>

          {/* v2.5.26 (W2.2): reply-to (in-reply-to a prior letter in this project). */}
          <Field label={t('correspondence.field.replyTo')}>
            <select
              disabled={readOnly}
              value={replyToId ?? ''}
              onChange={(e) => setReplyToId(e.target.value || null)}
              className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800 disabled:opacity-60"
            >
              <option value="">{t('correspondence.field.replyToNone')}</option>
              {replyCandidates.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.referenceNumber} — {l.subject}
                </option>
              ))}
            </select>
          </Field>

          {formError && <p className="text-sm text-danger" role="alert">{formError}</p>}

          {!readOnly && (
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-text-muted hover:underline px-3 py-1.5"
              >
                {t('common.close')}
              </button>
              <button
                type="submit"
                disabled={!subject.trim() || saveMut.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {savedId ? t('common.save') : t('correspondence.editor.create')}
              </button>
            </div>
          )}
        </form>

        {savedId ? (
          <>
            {replyTo && (
              <div className="border-t border-border pt-3 text-xs text-slate-500">
                {t('correspondence.field.inReplyTo')}:{' '}
                <span dir="ltr" className="font-mono">{replyTo.referenceNumber}</span> — {replyTo.subject}
              </div>
            )}
            <div className="border-t border-border pt-4">
              <LinkedTasksPanel
                teamId={teamId}
                projectId={projectId}
                letterId={savedId}
                canManage={canManage}
              />
            </div>
            <div className="border-t border-border pt-4">
              <LetterAttachments
                teamId={teamId}
                projectId={projectId}
                letterId={savedId}
                canManage={canManage}
              />
            </div>
            <div className="border-t border-border pt-4">
              <ReferralPanel
                teamId={teamId}
                projectId={projectId}
                letterId={savedId}
                canManage={canManage}
              />
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-400 italic border-t border-border pt-4">
            {t('correspondence.editor.saveFirst')}
          </p>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs text-text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
