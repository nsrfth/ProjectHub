import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as contactsApi from './api';
import { errorMessage } from '@/features/correspondence/api';
import Modal from '@/features/ui/Modal';
import { useT } from '@/lib/i18n';

interface ContactsPanelProps {
  teamId: string;
  canManage: boolean;
}

interface EditState {
  id: string | null; // null → creating
  name: string;
  organization: string;
  email: string;
  phone: string;
  type: contactsApi.ContactType;
}

const EMPTY: EditState = {
  id: null,
  name: '',
  organization: '',
  email: '',
  phone: '',
  type: 'PERSON',
};

export function ContactsPanel({ teamId, canManage }: ContactsPanelProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ['contacts', teamId],
    queryFn: () => contactsApi.listContacts(teamId),
    enabled: !!teamId,
  });

  const filtered = contacts.filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.organization ?? '').toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q)
    );
  });

  const saveMut = useMutation({
    mutationFn: (s: EditState) => {
      const input: contactsApi.ContactInput = {
        name: s.name.trim(),
        organization: s.organization.trim() || null,
        email: s.email.trim() || null,
        phone: s.phone.trim() || null,
        type: s.type,
      };
      return s.id
        ? contactsApi.updateContact(teamId, s.id, input)
        : contactsApi.createContact(teamId, input);
    },
    onSuccess: async () => {
      setFormError(null);
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['contacts', teamId] });
    },
    onError: (err) => setFormError(errorMessage(err, t('contacts.saveError'))),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => contactsApi.deleteContact(teamId, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contacts', teamId] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          placeholder={t('contacts.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border-border px-3 py-1.5 border text-sm dark:bg-slate-800 min-w-[14rem]"
        />
        {canManage && (
          <button
            type="button"
            onClick={() => {
              setFormError(null);
              setEditing({ ...EMPTY });
            }}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
          >
            {t('contacts.new')}
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-500 italic">{t('contacts.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {filtered.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium text-text truncate">
                  {c.name}
                  <span className="ms-2 text-[11px] uppercase tracking-wide text-slate-400">
                    {t(`contacts.type.${c.type}`)}
                  </span>
                </p>
                <p className="text-xs text-slate-500 truncate">
                  {[c.organization, c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setEditing({
                        id: c.id,
                        name: c.name,
                        organization: c.organization ?? '',
                        email: c.email ?? '',
                        phone: c.phone ?? '',
                        type: c.type,
                      });
                    }}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(t('contacts.deleteConfirm').replace('{name}', c.name))) {
                        deleteMut.mutate(c.id);
                      }
                    }}
                    disabled={deleteMut.isPending}
                    className="text-sm text-danger hover:underline disabled:opacity-50"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <Modal
          title={editing.id ? t('contacts.editTitle') : t('contacts.newTitle')}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMut.mutate(editing);
            }}
            className="space-y-3"
          >
            <Field label={t('contacts.field.name')}>
              <input
                type="text"
                required
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              />
            </Field>
            <Field label={t('contacts.field.type')}>
              <select
                value={editing.type}
                onChange={(e) =>
                  setEditing({ ...editing, type: e.target.value as contactsApi.ContactType })
                }
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              >
                <option value="PERSON">{t('contacts.type.PERSON')}</option>
                <option value="ORG">{t('contacts.type.ORG')}</option>
              </select>
            </Field>
            <Field label={t('contacts.field.organization')}>
              <input
                type="text"
                value={editing.organization}
                onChange={(e) => setEditing({ ...editing, organization: e.target.value })}
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              />
            </Field>
            <Field label={t('contacts.field.email')}>
              <input
                type="email"
                value={editing.email}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              />
            </Field>
            <Field label={t('contacts.field.phone')}>
              <input
                type="text"
                dir="ltr"
                value={editing.phone}
                onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              />
            </Field>
            {formError && <p className="text-sm text-danger" role="alert">{formError}</p>}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-sm text-text-muted hover:underline px-3 py-1.5"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={!editing.name.trim() || saveMut.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
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
