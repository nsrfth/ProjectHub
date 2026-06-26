import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import Modal from '@/features/ui/Modal';
import { isModuleDisabled, ModuleDisabledBanner } from '@/features/ui/ModuleDisabledBanner';
import * as api from './api';
import type { ContractStatus, PoStatus, BudgetCurrency } from './api';

interface Props {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

type Tab = 'vendors' | 'contracts' | 'pos';

const CONTRACT_STATUS_CLASSES: Record<ContractStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  CLOSED: 'bg-slate-200 text-slate-600 dark:bg-slate-600 dark:text-slate-300',
  CANCELLED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
};
const PO_STATUS_CLASSES: Record<PoStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  ISSUED: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  PARTIALLY_RECEIVED: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  RECEIVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  CLOSED: 'bg-slate-200 text-slate-600 dark:bg-slate-600 dark:text-slate-300',
  CANCELLED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
};

export function ProcurementPanel({ teamId, projectId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('vendors');
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Vendor form
  const [vName, setVName] = useState('');
  const [vEmail, setVEmail] = useState('');
  const [vPhone, setVPhone] = useState('');

  // Contract form
  const [cTitle, setCTitle] = useState('');
  const [cVendorId, setCVendorId] = useState('');
  const [cValue, setCValue] = useState('');
  const [cCurrency, setCCurrency] = useState<BudgetCurrency>('IRR');
  const [cStatus, setCStatus] = useState<ContractStatus>('DRAFT');

  // PO form
  const [pTitle, setPTitle] = useState('');
  const [pContractId, setPContractId] = useState('');
  const [pAmount, setPAmount] = useState('');
  const [pCurrency, setPCurrency] = useState<BudgetCurrency>('IRR');

  const vendors = useQuery({ queryKey: ['vendors', teamId], queryFn: () => api.listVendors(teamId) });
  const contracts = useQuery({ queryKey: ['contracts', teamId, projectId], queryFn: () => api.listContracts(teamId, projectId), retry: false });
  const pos = useQuery({ queryKey: ['purchaseOrders', teamId, projectId], queryFn: () => api.listPurchaseOrders(teamId, projectId), retry: false });

  const inv = (): void => {
    void qc.invalidateQueries({ queryKey: ['vendors', teamId] });
    void qc.invalidateQueries({ queryKey: ['contracts', teamId, projectId] });
    void qc.invalidateQueries({ queryKey: ['purchaseOrders', teamId, projectId] });
  };

  const createVendorMut = useMutation({
    mutationFn: () => api.createVendor(teamId, { name: vName.trim(), contactEmail: vEmail.trim() || null, contactPhone: vPhone.trim() || null }),
    onSuccess: () => { setShowCreate(false); setVName(''); setVEmail(''); setVPhone(''); inv(); },
    onError: () => setCreateError(t('procurement.createError')),
  });
  const deleteVendorMut = useMutation({
    mutationFn: (id: string) => api.deleteVendor(teamId, id),
    onSuccess: inv,
  });

  const createContractMut = useMutation({
    mutationFn: () => api.createContract(teamId, projectId, {
      title: cTitle.trim(),
      vendorId: cVendorId || null,
      status: cStatus,
      valueMinor: cValue ? Math.round(parseFloat(cValue)) : null,
      currency: cValue ? cCurrency : null,
    }),
    onSuccess: () => { setShowCreate(false); setCTitle(''); setCVendorId(''); setCValue(''); inv(); },
    onError: () => setCreateError(t('procurement.createError')),
  });

  const createPoMut = useMutation({
    mutationFn: () => api.createPurchaseOrder(teamId, projectId, {
      title: pTitle.trim(),
      contractId: pContractId || null,
      amountMinor: pAmount ? Math.round(parseFloat(pAmount)) : null,
      currency: pAmount ? pCurrency : null,
    }),
    onSuccess: () => { setShowCreate(false); setPTitle(''); setPContractId(''); setPAmount(''); inv(); },
    onError: () => setCreateError(t('procurement.createError')),
  });

  const handleCreate = (e: React.FormEvent): void => {
    e.preventDefault();
    setCreateError(null);
    if (tab === 'vendors') createVendorMut.mutate();
    else if (tab === 'contracts') createContractMut.mutate();
    else createPoMut.mutate();
  };

  if (contracts.isError && isModuleDisabled(contracts.error)) return <ModuleDisabledBanner />;

  const isPending = createVendorMut.isPending || createContractMut.isPending || createPoMut.isPending;
  const canSubmit = tab === 'vendors' ? !!vName.trim() : tab === 'contracts' ? !!cTitle.trim() : !!pTitle.trim();

  const tabClass = (active: boolean): string =>
    `px-3 py-1.5 text-sm border-b-2 ${active ? 'border-primary text-primary font-medium' : 'border-transparent text-text-muted hover:text-text'}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-0">
          <button className={tabClass(tab === 'vendors')} onClick={() => setTab('vendors')}>{t('procurement.vendors.title')}</button>
          <button className={tabClass(tab === 'contracts')} onClick={() => setTab('contracts')}>{t('procurement.contracts.title')}</button>
          <button className={tabClass(tab === 'pos')} onClick={() => setTab('pos')}>{t('procurement.pos.title')}</button>
        </div>
        {canManage && (
          <button
            onClick={() => { setShowCreate(true); setCreateError(null); }}
            className="text-sm px-3 py-1.5 rounded bg-primary text-primary-contrast"
          >
            + {t(`procurement.${tab}.new`)}
          </button>
        )}
      </div>

      {tab === 'vendors' && (
        <div className="overflow-x-auto">
          {(vendors.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-text-muted">{t('procurement.vendors.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th className="py-2 pr-3">{t('procurement.vendors.col.name')}</th>
                  <th className="py-2 pr-3">{t('procurement.vendors.col.email')}</th>
                  <th className="py-2 pr-3">{t('procurement.vendors.col.phone')}</th>
                  {canManage && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {vendors.data?.map((v) => (
                  <tr key={v.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3">{v.name}</td>
                    <td className="py-2 pr-3 text-xs">{v.contactEmail ?? '—'}</td>
                    <td className="py-2 pr-3 text-xs">{v.contactPhone ?? '—'}</td>
                    {canManage && (
                      <td className="py-2 text-right">
                        <button
                          onClick={() => { if (window.confirm(t('procurement.vendors.deleteConfirm'))) deleteVendorMut.mutate(v.id); }}
                          className="text-xs text-danger hover:underline"
                        >
                          {t('procurement.vendors.delete')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'contracts' && (
        <div className="overflow-x-auto">
          {(contracts.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-text-muted">{t('procurement.contracts.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th className="py-2 pr-3">{t('procurement.contracts.col.reference')}</th>
                  <th className="py-2 pr-3">{t('procurement.contracts.col.title')}</th>
                  <th className="py-2 pr-3">{t('procurement.contracts.col.vendor')}</th>
                  <th className="py-2 pr-3">{t('procurement.contracts.col.status')}</th>
                  <th className="py-2 pr-3">{t('procurement.contracts.col.value')}</th>
                </tr>
              </thead>
              <tbody>
                {contracts.data?.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{c.reference}</td>
                    <td className="py-2 pr-3 max-w-xs truncate">{c.title}</td>
                    <td className="py-2 pr-3 text-xs">{c.vendorName ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${CONTRACT_STATUS_CLASSES[c.status]}`}>
                        {t(`procurement.contracts.status.${c.status}` as never)}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-xs">{c.valueMinor != null ? `${c.valueMinor} ${c.currency ?? ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'pos' && (
        <div className="overflow-x-auto">
          {(pos.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-text-muted">{t('procurement.pos.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th className="py-2 pr-3">{t('procurement.pos.col.reference')}</th>
                  <th className="py-2 pr-3">{t('procurement.pos.col.title')}</th>
                  <th className="py-2 pr-3">{t('procurement.pos.col.contract')}</th>
                  <th className="py-2 pr-3">{t('procurement.pos.col.status')}</th>
                  <th className="py-2 pr-3">{t('procurement.pos.col.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {pos.data?.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{p.reference}</td>
                    <td className="py-2 pr-3 max-w-xs truncate">{p.title}</td>
                    <td className="py-2 pr-3 text-xs">{p.contractId ? contracts.data?.find((c) => c.id === p.contractId)?.reference ?? '—' : '—'}</td>
                    <td className="py-2 pr-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${PO_STATUS_CLASSES[p.status]}`}>
                        {t(`procurement.pos.status.${p.status}` as never)}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-xs">{p.amountMinor != null ? `${p.amountMinor} ${p.currency ?? ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showCreate && (
        <Modal title={`+ ${t(`procurement.${tab}.new`)}`} onClose={() => setShowCreate(false)}>
          <form className="space-y-3" onSubmit={handleCreate}>
            {createError && <p className="text-sm text-danger">{createError}</p>}

            {tab === 'vendors' && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.vendors.form.name')}</span>
                  <input required value={vName} onChange={(e) => setVName(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.vendors.form.email')}</span>
                  <input type="email" value={vEmail} onChange={(e) => setVEmail(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.vendors.form.phone')}</span>
                  <input value={vPhone} onChange={(e) => setVPhone(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" />
                </label>
              </>
            )}

            {tab === 'contracts' && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.contracts.form.title')}</span>
                  <input required value={cTitle} onChange={(e) => setCTitle(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.contracts.form.vendor')}</span>
                  <select value={cVendorId} onChange={(e) => setCVendorId(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700">
                    <option value="">— {t('procurement.contracts.form.noVendor')} —</option>
                    {vendors.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.contracts.form.status')}</span>
                  <select value={cStatus} onChange={(e) => setCStatus(e.target.value as ContractStatus)} className="rounded border px-2 py-1.5 dark:bg-slate-700">
                    {(['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] as ContractStatus[]).map((s) => (
                      <option key={s} value={s}>{t(`procurement.contracts.status.${s}` as never)}</option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span>{t('procurement.contracts.form.value')}</span>
                    <input type="number" min="0" value={cValue} onChange={(e) => setCValue(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" dir="ltr" />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>{t('procurement.contracts.form.currency')}</span>
                    <select value={cCurrency} onChange={(e) => setCCurrency(e.target.value as BudgetCurrency)} className="rounded border px-2 py-1.5 dark:bg-slate-700">
                      <option value="IRR">IRR</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                  </label>
                </div>
              </>
            )}

            {tab === 'pos' && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.pos.form.title')}</span>
                  <input required value={pTitle} onChange={(e) => setPTitle(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('procurement.pos.form.contract')}</span>
                  <select value={pContractId} onChange={(e) => setPContractId(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700">
                    <option value="">— {t('procurement.pos.form.noContract')} —</option>
                    {contracts.data?.map((c) => <option key={c.id} value={c.id}>{c.reference} — {c.title}</option>)}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span>{t('procurement.pos.form.amount')}</span>
                    <input type="number" min="0" value={pAmount} onChange={(e) => setPAmount(e.target.value)} className="rounded border px-2 py-1.5 dark:bg-slate-700" dir="ltr" />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>{t('procurement.pos.form.currency')}</span>
                    <select value={pCurrency} onChange={(e) => setPCurrency(e.target.value as BudgetCurrency)} className="rounded border px-2 py-1.5 dark:bg-slate-700">
                      <option value="IRR">IRR</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                  </label>
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm rounded border">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={isPending || !canSubmit}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
              >
                {t(`procurement.${tab}.form.create`)}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
