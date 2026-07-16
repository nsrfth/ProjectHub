import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as contactsApi from './api';
import { errorMessage } from '@/features/correspondence/api';
import { useT } from '@/lib/i18n';

interface ContactPickerProps {
  teamId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  // Whether the current user may create a contact inline.
  canManage?: boolean;
  placeholder?: string;
}

// Searchable select over the team's contacts directory with an inline
// "+ Add contact" affordance. Backed by the ['contacts', teamId] query so it
// shares cache with ContactsPanel.
export function ContactPicker({
  teamId,
  value,
  onChange,
  canManage = false,
  placeholder,
}: ContactPickerProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newOrg, setNewOrg] = useState('');
  const [newType, setNewType] = useState<contactsApi.ContactType>('PERSON');
  const [addError, setAddError] = useState<string | null>(null);

  const { data: contacts = [] } = useQuery({
    queryKey: ['contacts', teamId],
    queryFn: () => contactsApi.listContacts(teamId),
    enabled: !!teamId,
  });

  const createMut = useMutation({
    mutationFn: () =>
      contactsApi.createContact(teamId, {
        name: newName.trim(),
        organization: newOrg.trim() || null,
        type: newType,
      }),
    onSuccess: async (c) => {
      setAddError(null);
      setAdding(false);
      setNewName('');
      setNewOrg('');
      setNewType('PERSON');
      await qc.invalidateQueries({ queryKey: ['contacts', teamId] });
      onChange(c.id);
    },
    onError: (err) => setAddError(errorMessage(err, t('contacts.saveError'))),
  });

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="flex-1 rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
        >
          <option value="">{placeholder ?? t('contacts.none')}</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.organization ? ` — ${c.organization}` : ''}
            </option>
          ))}
        </select>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs text-primary hover:underline shrink-0"
          >
            {t('contacts.addInline')}
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded border border-border p-2 space-y-2 bg-bg-elevated">
          <input
            type="text"
            placeholder={t('contacts.field.name')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
          />
          <input
            type="text"
            placeholder={t('contacts.field.organization')}
            value={newOrg}
            onChange={(e) => setNewOrg(e.target.value)}
            className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as contactsApi.ContactType)}
            className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
          >
            <option value="PERSON">{t('contacts.type.PERSON')}</option>
            <option value="ORG">{t('contacts.type.ORG')}</option>
          </select>
          {addError && <p className="text-xs text-danger" role="alert">{addError}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={!newName.trim() || createMut.isPending}
              className="text-xs rounded bg-primary text-primary-contrast px-2 py-1 disabled:opacity-50"
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setAddError(null);
              }}
              className="text-xs text-text-muted hover:underline"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
