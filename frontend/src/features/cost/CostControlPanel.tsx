import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { isModuleDisabled, ModuleDisabledBanner } from '@/features/ui/ModuleDisabledBanner';
import * as api from './api';
import type { CommitmentStatus, ExpenseStatus } from './api';

interface Props {
  teamId: string;
  projectId: string;
  canManage: boolean;
}

type Tab = 'summary' | 'accounts' | 'budget' | 'commitments' | 'expenses' | 'actuals' | 'fx';
type Currency = 'IRR' | 'USD' | 'EUR';
const CURRENCIES: Currency[] = ['IRR', 'USD', 'EUR'];
const DECIMALS: Record<string, number> = { IRR: 0, USD: 2, EUR: 2 };

function toMinor(amount: string, currency: string): string {
  const dec = DECIMALS[currency] ?? 2;
  return String(Math.round((parseFloat(amount) || 0) * 10 ** dec));
}
function ymd(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

const COMMIT_CLASSES: Record<CommitmentStatus, string> = {
  OPEN: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  CLOSED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  CANCELLED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
};
const EXPENSE_CLASSES: Record<ExpenseStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  SUBMITTED: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
};

// v1.90 (PMIS R4 GUI completion): full cost-control surface — CBS accounts,
// budget lines, commitments, expenses (with approve/reject), the actual-cost
// ledger (manual entry + reversal), and team FX reference rates. Profile-gated
// by cost_control; the summary 403s when disabled.
export function CostControlPanel({ teamId, projectId, canManage }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('summary');

  const summary = useQuery({
    queryKey: ['cost', teamId, projectId, 'summary'],
    queryFn: () => api.getCostSummary(teamId, projectId),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['cost', teamId, projectId, 'accounts'],
    queryFn: () => api.listCostAccounts(teamId, projectId),
    enabled: !summary.isError,
    retry: false,
  });
  const budgetLines = useQuery({
    queryKey: ['cost', teamId, projectId, 'budget-lines'],
    queryFn: () => api.listBudgetLines(teamId, projectId),
    enabled: !summary.isError,
    retry: false,
  });
  const commitments = useQuery({
    queryKey: ['cost', teamId, projectId, 'commitments'],
    queryFn: () => api.listCommitments(teamId, projectId),
    enabled: !summary.isError,
    retry: false,
  });
  const expenses = useQuery({
    queryKey: ['cost', teamId, projectId, 'expenses'],
    queryFn: () => api.listExpenses(teamId, projectId),
    enabled: !summary.isError,
    retry: false,
  });
  const actuals = useQuery({
    queryKey: ['cost', teamId, projectId, 'actuals'],
    queryFn: () => api.listActuals(teamId, projectId),
    enabled: !summary.isError,
    retry: false,
  });
  const fxRates = useQuery({
    queryKey: ['fx-rates', teamId],
    queryFn: () => api.listFxRates(teamId),
    enabled: !summary.isError,
    retry: false,
  });

  const inv = (): void => {
    void qc.invalidateQueries({ queryKey: ['cost', teamId, projectId] });
    void qc.invalidateQueries({ queryKey: ['fx-rates', teamId] });
  };

  if (summary.isError) {
    return isModuleDisabled(summary.error) ? <ModuleDisabledBanner /> : <></>;
  }

  const accountOpts = accounts.data ?? [];
  const tabClass = (active: boolean): string =>
    `px-3 py-1.5 text-sm border-b-2 whitespace-nowrap ${
      active ? 'border-primary text-primary font-medium' : 'border-transparent text-text-muted hover:text-text'
    }`;

  const TABS: Tab[] = ['summary', 'accounts', 'budget', 'commitments', 'expenses', 'actuals', 'fx'];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tb) => (
          <button key={tb} className={tabClass(tab === tb)} onClick={() => setTab(tb)}>
            {t(`cost.tab.${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <SummaryTab summary={summary.data} />
      )}

      {tab === 'accounts' && (
        <AccountsTab
          accounts={accountOpts}
          canManage={canManage}
          onCreate={(input) => api.createCostAccount(teamId, projectId, input)}
          onRename={(id, name) => api.renameCostAccount(teamId, projectId, id, name)}
          onDelete={(id) => api.deleteCostAccount(teamId, projectId, id)}
          onChanged={inv}
        />
      )}

      {tab === 'budget' && (
        <BudgetTab
          lines={budgetLines.data ?? []}
          accounts={accountOpts}
          canManage={canManage}
          onCreate={(input) => api.createBudgetLine(teamId, projectId, input)}
          onDelete={(id) => api.deleteBudgetLine(teamId, projectId, id)}
          onChanged={inv}
        />
      )}

      {tab === 'commitments' && (
        <CommitmentsTab
          items={commitments.data ?? []}
          accounts={accountOpts}
          canManage={canManage}
          onCreate={(input) => api.createCommitment(teamId, projectId, input)}
          onSetStatus={(id, status) => api.setCommitmentStatus(teamId, projectId, id, status)}
          onChanged={inv}
        />
      )}

      {tab === 'expenses' && (
        <ExpensesTab
          items={expenses.data ?? []}
          accounts={accountOpts}
          canManage={canManage}
          onCreate={(input) => api.createExpense(teamId, projectId, input)}
          onApprove={(id) => api.approveExpense(teamId, projectId, id)}
          onReject={(id) => api.rejectExpense(teamId, projectId, id)}
          onChanged={inv}
        />
      )}

      {tab === 'actuals' && (
        <ActualsTab
          items={actuals.data ?? []}
          accounts={accountOpts}
          canManage={canManage}
          onCreate={(input) => api.createActual(teamId, projectId, input)}
          onReverse={(id) => api.reverseActual(teamId, projectId, id)}
          onChanged={inv}
        />
      )}

      {tab === 'fx' && (
        <FxTab
          items={fxRates.data ?? []}
          canManage={canManage}
          onCreate={(input) => api.createFxRate(teamId, input)}
          onChanged={inv}
        />
      )}
    </div>
  );
}

// ── Summary ────────────────────────────────────────────────────────────────
function SummaryTab({ summary }: { summary: api.ProjectCostSummary | undefined }): JSX.Element {
  const t = useT();
  if (!summary) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-text-muted border-b border-border">
          <th className="py-2 pr-3">{t('cost.currency')}</th>
          <th className="py-2 pr-3 text-right">{t('cost.planned')}</th>
          <th className="py-2 pr-3 text-right">{t('cost.committed')}</th>
          <th className="py-2 pr-3 text-right">{t('cost.actual')}</th>
          <th className="py-2 pr-3 text-right">{t('cost.remaining')}</th>
        </tr>
      </thead>
      <tbody>
        {summary.byCurrency.length === 0 ? (
          <tr><td colSpan={5} className="py-2 text-text-muted">{t('cost.empty')}</td></tr>
        ) : (
          summary.byCurrency.map((b) => (
            <tr key={b.currency} className="border-b border-border last:border-0">
              <td className="py-2 pr-3">{b.currency}</td>
              <td className="py-2 pr-3 text-right" dir="ltr">{b.planned}</td>
              <td className="py-2 pr-3 text-right" dir="ltr">{b.committed}</td>
              <td className="py-2 pr-3 text-right" dir="ltr">{b.actual}</td>
              <td className="py-2 pr-3 text-right" dir="ltr">{b.remaining}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// ── Accounts (CBS) ───────────────────────────────────────────────────────────
function AccountsTab({
  accounts, canManage, onCreate, onRename, onDelete, onChanged,
}: {
  accounts: api.CostAccount[];
  canManage: boolean;
  onCreate: (i: { code: string; name: string; parentId?: string | null }) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');

  const createMut = useMutation({
    mutationFn: () => onCreate({ code: code.trim(), name: name.trim(), parentId: parentId || null }),
    onSuccess: () => { setCode(''); setName(''); setParentId(''); onChanged(); },
  });
  const renameMut = useMutation({
    mutationFn: (v: { id: string; name: string }) => onRename(v.id, v.name),
    onSuccess: onChanged,
  });
  const deleteMut = useMutation({ mutationFn: (id: string) => onDelete(id), onSuccess: onChanged });

  return (
    <div className="space-y-3">
      {accounts.length === 0 ? (
        <p className="text-sm text-text-muted">{t('cost.accounts.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">{t('cost.accounts.code')}</th>
              <th className="py-2 pr-3">{t('cost.accounts.name')}</th>
              <th className="py-2 pr-3">{t('cost.accounts.lines')}</th>
              {canManage && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3 font-mono text-xs" dir="ltr">{a.path}</td>
                <td className="py-2 pr-3">
                  {a.name}
                  {a.isDefault && <span className="ms-2 text-[10px] uppercase text-text-muted">{t('cost.accounts.default')}</span>}
                </td>
                <td className="py-2 pr-3 text-xs">{a.budgetLineCount}</td>
                {canManage && (
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => {
                        const nn = window.prompt(t('cost.accounts.rename'), a.name);
                        if (nn && nn.trim()) renameMut.mutate({ id: a.id, name: nn.trim() });
                      }}
                      className="text-xs text-primary hover:underline me-3"
                    >
                      {t('common.edit')}
                    </button>
                    {!a.isDefault && a.budgetLineCount === 0 && a.childCount === 0 && (
                      <button
                        onClick={() => { if (window.confirm(t('cost.accounts.deleteConfirm'))) deleteMut.mutate(a.id); }}
                        className="text-xs text-danger hover:underline"
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(createMut.isError || renameMut.isError || deleteMut.isError) && (
        <p className="text-sm text-rose-600">{t('cost.actionError')}</p>
      )}
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
          onSubmit={(e: FormEvent) => { e.preventDefault(); if (code.trim() && name.trim()) createMut.mutate(); }}
        >
          <label className="text-xs text-text-muted">{t('cost.accounts.code')}
            <input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" placeholder="1.2"
              className="ms-1 w-24 rounded border border-border bg-surface px-2 py-1 text-sm font-mono" />
          </label>
          <label className="text-xs text-text-muted">{t('cost.accounts.name')}
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="ms-1 w-40 rounded border border-border bg-surface px-2 py-1 text-sm" />
          </label>
          <label className="text-xs text-text-muted">{t('cost.accounts.parent')}
            <select value={parentId} onChange={(e) => setParentId(e.target.value)}
              className="ms-1 rounded border border-border bg-surface px-2 py-1 text-sm">
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.path}</option>)}
            </select>
          </label>
          <button type="submit" disabled={!code.trim() || !name.trim() || createMut.isPending}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50">
            {t('cost.accounts.add')}
          </button>
        </form>
      )}
    </div>
  );
}

// ── Budget lines ─────────────────────────────────────────────────────────────
function BudgetTab({
  lines, accounts, canManage, onCreate, onDelete, onChanged,
}: {
  lines: api.BudgetLine[];
  accounts: api.CostAccount[];
  canManage: boolean;
  onCreate: (i: { amountMinor: string; currency: string; note?: string; costAccountId?: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('IRR');
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');

  const createMut = useMutation({
    mutationFn: () => onCreate({
      amountMinor: toMinor(amount, currency), currency,
      note: note.trim() || undefined, costAccountId: accountId || undefined,
    }),
    onSuccess: () => { setAmount(''); setNote(''); onChanged(); },
  });
  const deleteMut = useMutation({ mutationFn: (id: string) => onDelete(id), onSuccess: onChanged });

  return (
    <div className="space-y-3">
      {lines.length === 0 ? (
        <p className="text-sm text-text-muted">{t('cost.budget.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">{t('cost.accounts.code')}</th>
              <th className="py-2 pr-3 text-right">{t('cost.amount')}</th>
              <th className="py-2 pr-3">{t('cost.note')}</th>
              {canManage && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3 font-mono text-xs" dir="ltr">{l.costAccountCode ?? '—'}</td>
                <td className="py-2 pr-3 text-right" dir="ltr">{l.amount} {l.currency}</td>
                <td className="py-2 pr-3 text-xs">{l.note ?? '—'}</td>
                {canManage && (
                  <td className="py-2 text-right">
                    <button
                      onClick={() => { if (window.confirm(t('cost.budget.deleteConfirm'))) deleteMut.mutate(l.id); }}
                      className="text-xs text-danger hover:underline"
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(createMut.isError || deleteMut.isError) && <p className="text-sm text-rose-600">{t('cost.actionError')}</p>}
      {canManage && (
        <AmountForm
          amount={amount} setAmount={setAmount}
          currency={currency} setCurrency={setCurrency}
          accountId={accountId} setAccountId={setAccountId}
          accounts={accounts}
          extra={
            <label className="text-xs text-text-muted">{t('cost.note')}
              <input value={note} onChange={(e) => setNote(e.target.value)}
                className="ms-1 w-40 rounded border border-border bg-surface px-2 py-1 text-sm" />
            </label>
          }
          submitLabel={t('cost.budget.add')}
          disabled={!amount || createMut.isPending}
          onSubmit={() => createMut.mutate()}
        />
      )}
    </div>
  );
}

// ── Commitments ──────────────────────────────────────────────────────────────
function CommitmentsTab({
  items, accounts, canManage, onCreate, onSetStatus, onChanged,
}: {
  items: api.Commitment[];
  accounts: api.CostAccount[];
  canManage: boolean;
  onCreate: (i: { amountMinor: string; currency: string; vendorName?: string; reference?: string; incurredOn?: string; costAccountId?: string | null }) => Promise<unknown>;
  onSetStatus: (id: string, s: CommitmentStatus) => Promise<unknown>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('IRR');
  const [accountId, setAccountId] = useState('');
  const [vendor, setVendor] = useState('');
  const [reference, setReference] = useState('');

  const createMut = useMutation({
    mutationFn: () => onCreate({
      amountMinor: toMinor(amount, currency), currency,
      vendorName: vendor.trim() || undefined, reference: reference.trim() || undefined,
      costAccountId: accountId || null,
    }),
    onSuccess: () => { setAmount(''); setVendor(''); setReference(''); onChanged(); },
  });
  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: CommitmentStatus }) => onSetStatus(v.id, v.status),
    onSuccess: onChanged,
  });

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('cost.commitments.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">{t('cost.commitments.vendor')}</th>
              <th className="py-2 pr-3">{t('cost.commitments.reference')}</th>
              <th className="py-2 pr-3 text-right">{t('cost.amount')}</th>
              <th className="py-2 pr-3">{t('cost.status')}</th>
              {canManage && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3">{c.vendorName ?? '—'}</td>
                <td className="py-2 pr-3 text-xs" dir="ltr">{c.reference ?? '—'}</td>
                <td className="py-2 pr-3 text-right" dir="ltr">{c.amount} {c.currency}</td>
                <td className="py-2 pr-3">
                  <span className={`text-[11px] rounded-full px-2 py-0.5 ${COMMIT_CLASSES[c.status]}`}>
                    {t(`cost.commitments.status.${c.status}`)}
                  </span>
                </td>
                {canManage && (
                  <td className="py-2 text-right whitespace-nowrap">
                    {c.status === 'OPEN' && (
                      <>
                        <button onClick={() => statusMut.mutate({ id: c.id, status: 'CLOSED' })}
                          className="text-xs text-primary hover:underline me-3">{t('cost.commitments.close')}</button>
                        <button onClick={() => statusMut.mutate({ id: c.id, status: 'CANCELLED' })}
                          className="text-xs text-danger hover:underline">{t('cost.commitments.cancel')}</button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(createMut.isError || statusMut.isError) && <p className="text-sm text-rose-600">{t('cost.actionError')}</p>}
      {canManage && (
        <AmountForm
          amount={amount} setAmount={setAmount}
          currency={currency} setCurrency={setCurrency}
          accountId={accountId} setAccountId={setAccountId}
          accounts={accounts}
          extra={
            <>
              <label className="text-xs text-text-muted">{t('cost.commitments.vendor')}
                <input value={vendor} onChange={(e) => setVendor(e.target.value)}
                  className="ms-1 w-32 rounded border border-border bg-surface px-2 py-1 text-sm" />
              </label>
              <label className="text-xs text-text-muted">{t('cost.commitments.reference')}
                <input value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr"
                  className="ms-1 w-28 rounded border border-border bg-surface px-2 py-1 text-sm" />
              </label>
            </>
          }
          submitLabel={t('cost.commitments.add')}
          disabled={!amount || createMut.isPending}
          onSubmit={() => createMut.mutate()}
        />
      )}
    </div>
  );
}

// ── Expenses ─────────────────────────────────────────────────────────────────
function ExpensesTab({
  items, accounts, canManage, onCreate, onApprove, onReject, onChanged,
}: {
  items: api.Expense[];
  accounts: api.CostAccount[];
  canManage: boolean;
  onCreate: (i: { amountMinor: string; currency: string; incurredOn: string; description?: string; costAccountId?: string | null }) => Promise<unknown>;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string) => Promise<unknown>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('IRR');
  const [accountId, setAccountId] = useState('');
  const [description, setDescription] = useState('');
  const [incurredOn, setIncurredOn] = useState<string | null>(new Date().toISOString());

  const createMut = useMutation({
    mutationFn: () => onCreate({
      amountMinor: toMinor(amount, currency), currency,
      incurredOn: ymd(incurredOn) ?? new Date().toISOString().slice(0, 10),
      description: description.trim() || undefined, costAccountId: accountId || null,
    }),
    onSuccess: () => { setAmount(''); setDescription(''); onChanged(); },
  });
  const approveMut = useMutation({ mutationFn: (id: string) => onApprove(id), onSuccess: onChanged });
  const rejectMut = useMutation({ mutationFn: (id: string) => onReject(id), onSuccess: onChanged });

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('cost.expenses.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">{t('cost.expenses.date')}</th>
              <th className="py-2 pr-3 text-right">{t('cost.amount')}</th>
              <th className="py-2 pr-3">{t('cost.note')}</th>
              <th className="py-2 pr-3">{t('cost.status')}</th>
              {canManage && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3 text-xs" dir="ltr">{x.incurredOn.slice(0, 10)}</td>
                <td className="py-2 pr-3 text-right" dir="ltr">{x.amount} {x.currency}</td>
                <td className="py-2 pr-3 text-xs">{x.description ?? '—'}</td>
                <td className="py-2 pr-3">
                  <span className={`text-[11px] rounded-full px-2 py-0.5 ${EXPENSE_CLASSES[x.status]}`}>
                    {t(`cost.expenses.status.${x.status}`)}
                  </span>
                </td>
                {canManage && (
                  <td className="py-2 text-right whitespace-nowrap">
                    {(x.status === 'SUBMITTED' || x.status === 'DRAFT') && (
                      <>
                        <button onClick={() => approveMut.mutate(x.id)}
                          className="text-xs text-emerald-600 hover:underline me-3">{t('cost.expenses.approve')}</button>
                        <button onClick={() => rejectMut.mutate(x.id)}
                          className="text-xs text-danger hover:underline">{t('cost.expenses.reject')}</button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(createMut.isError || approveMut.isError || rejectMut.isError) && <p className="text-sm text-rose-600">{t('cost.actionError')}</p>}
      {canManage && (
        <AmountForm
          amount={amount} setAmount={setAmount}
          currency={currency} setCurrency={setCurrency}
          accountId={accountId} setAccountId={setAccountId}
          accounts={accounts}
          extra={
            <>
              <label className="text-xs text-text-muted">{t('cost.expenses.date')}
                <span className="ms-1 inline-block"><ShamsiDatePicker value={incurredOn} onChange={setIncurredOn} /></span>
              </label>
              <label className="text-xs text-text-muted">{t('cost.note')}
                <input value={description} onChange={(e) => setDescription(e.target.value)}
                  className="ms-1 w-36 rounded border border-border bg-surface px-2 py-1 text-sm" />
              </label>
            </>
          }
          submitLabel={t('cost.expenses.add')}
          disabled={!amount || !incurredOn || createMut.isPending}
          onSubmit={() => createMut.mutate()}
        />
      )}
    </div>
  );
}

// ── Actual-cost ledger ───────────────────────────────────────────────────────
function ActualsTab({
  items, accounts, canManage, onCreate, onReverse, onChanged,
}: {
  items: api.ActualCostEntry[];
  accounts: api.CostAccount[];
  canManage: boolean;
  onCreate: (i: { amountMinor: string; currency: string; incurredOn: string; description?: string; costAccountId?: string | null }) => Promise<unknown>;
  onReverse: (id: string) => Promise<unknown>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('IRR');
  const [accountId, setAccountId] = useState('');
  const [description, setDescription] = useState('');
  const [incurredOn, setIncurredOn] = useState<string | null>(new Date().toISOString());

  const createMut = useMutation({
    mutationFn: () => onCreate({
      amountMinor: toMinor(amount, currency), currency,
      incurredOn: ymd(incurredOn) ?? new Date().toISOString().slice(0, 10),
      description: description.trim() || undefined, costAccountId: accountId || null,
    }),
    onSuccess: () => { setAmount(''); setDescription(''); onChanged(); },
  });
  const reverseMut = useMutation({ mutationFn: (id: string) => onReverse(id), onSuccess: onChanged });

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('cost.actuals.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">{t('cost.expenses.date')}</th>
              <th className="py-2 pr-3">{t('cost.source')}</th>
              <th className="py-2 pr-3 text-right">{t('cost.amount')}</th>
              <th className="py-2 pr-3">{t('cost.note')}</th>
              {canManage && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} className={`border-b border-border last:border-0 ${a.reversalOfId ? 'opacity-60' : ''}`}>
                <td className="py-2 pr-3 text-xs" dir="ltr">{a.incurredOn.slice(0, 10)}</td>
                <td className="py-2 pr-3 text-xs">{t(`cost.source.${a.source}`)}</td>
                <td className="py-2 pr-3 text-right" dir="ltr">{a.amount} {a.currency}</td>
                <td className="py-2 pr-3 text-xs">{a.description ?? '—'}</td>
                {canManage && (
                  <td className="py-2 text-right">
                    {!a.reversalOfId && a.source === 'MANUAL' && (
                      <button
                        onClick={() => { if (window.confirm(t('cost.actuals.reverseConfirm'))) reverseMut.mutate(a.id); }}
                        className="text-xs text-danger hover:underline"
                      >
                        {t('cost.actuals.reverse')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(createMut.isError || reverseMut.isError) && <p className="text-sm text-rose-600">{t('cost.actionError')}</p>}
      {canManage && (
        <AmountForm
          amount={amount} setAmount={setAmount}
          currency={currency} setCurrency={setCurrency}
          accountId={accountId} setAccountId={setAccountId}
          accounts={accounts}
          extra={
            <>
              <label className="text-xs text-text-muted">{t('cost.expenses.date')}
                <span className="ms-1 inline-block"><ShamsiDatePicker value={incurredOn} onChange={setIncurredOn} /></span>
              </label>
              <label className="text-xs text-text-muted">{t('cost.note')}
                <input value={description} onChange={(e) => setDescription(e.target.value)}
                  className="ms-1 w-36 rounded border border-border bg-surface px-2 py-1 text-sm" />
              </label>
            </>
          }
          submitLabel={t('cost.actuals.add')}
          disabled={!amount || !incurredOn || createMut.isPending}
          onSubmit={() => createMut.mutate()}
        />
      )}
    </div>
  );
}

// ── FX rates ─────────────────────────────────────────────────────────────────
function FxTab({
  items, canManage, onCreate, onChanged,
}: {
  items: api.FxRate[];
  canManage: boolean;
  onCreate: (i: { baseCurrency: string; quoteCurrency: string; rate: string; asOf: string }) => Promise<unknown>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const [baseCurrency, setBase] = useState<Currency>('USD');
  const [quoteCurrency, setQuote] = useState<Currency>('IRR');
  const [rate, setRate] = useState('');
  const [asOf, setAsOf] = useState<string | null>(new Date().toISOString());

  const createMut = useMutation({
    mutationFn: () => onCreate({
      baseCurrency, quoteCurrency, rate: rate.trim(),
      asOf: ymd(asOf) ?? new Date().toISOString().slice(0, 10),
    }),
    onSuccess: () => { setRate(''); onChanged(); },
  });

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('cost.fx.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">{t('cost.fx.pair')}</th>
              <th className="py-2 pr-3 text-right">{t('cost.fx.rate')}</th>
              <th className="py-2 pr-3">{t('cost.fx.asOf')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3" dir="ltr">{f.baseCurrency} → {f.quoteCurrency}</td>
                <td className="py-2 pr-3 text-right" dir="ltr">{f.rate}</td>
                <td className="py-2 pr-3 text-xs" dir="ltr">{f.asOf.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {createMut.isError && <p className="text-sm text-rose-600">{t('cost.actionError')}</p>}
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
          onSubmit={(e: FormEvent) => { e.preventDefault(); if (rate.trim() && asOf) createMut.mutate(); }}
        >
          <label className="text-xs text-text-muted">{t('cost.fx.base')}
            <select value={baseCurrency} onChange={(e) => setBase(e.target.value as Currency)}
              className="ms-1 rounded border border-border bg-surface px-2 py-1 text-sm">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-text-muted">{t('cost.fx.quote')}
            <select value={quoteCurrency} onChange={(e) => setQuote(e.target.value as Currency)}
              className="ms-1 rounded border border-border bg-surface px-2 py-1 text-sm">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-text-muted">{t('cost.fx.rate')}
            <input value={rate} onChange={(e) => setRate(e.target.value)} dir="ltr" placeholder="500000"
              className="ms-1 w-28 rounded border border-border bg-surface px-2 py-1 text-sm" />
          </label>
          <label className="text-xs text-text-muted">{t('cost.fx.asOf')}
            <span className="ms-1 inline-block"><ShamsiDatePicker value={asOf} onChange={setAsOf} /></span>
          </label>
          <button type="submit" disabled={!rate.trim() || !asOf || createMut.isPending}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50">
            {t('cost.fx.add')}
          </button>
        </form>
      )}
    </div>
  );
}

// Shared amount + currency + account create form used by budget/commitment/
// expense/actual tabs. `extra` slots in tab-specific fields.
function AmountForm({
  amount, setAmount, currency, setCurrency, accountId, setAccountId, accounts, extra, submitLabel, disabled, onSubmit,
}: {
  amount: string;
  setAmount: (v: string) => void;
  currency: Currency;
  setCurrency: (v: Currency) => void;
  accountId: string;
  setAccountId: (v: string) => void;
  accounts: api.CostAccount[];
  extra?: React.ReactNode;
  submitLabel: string;
  disabled: boolean;
  onSubmit: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e: FormEvent) => { e.preventDefault(); if (!disabled) onSubmit(); }}
    >
      <label className="text-xs text-text-muted">{t('cost.amount')}
        <input type="number" min="0" step="0.01" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)}
          className="ms-1 w-28 rounded border border-border bg-surface px-2 py-1 text-sm" />
      </label>
      <label className="text-xs text-text-muted">{t('cost.currency')}
        <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}
          className="ms-1 rounded border border-border bg-surface px-2 py-1 text-sm">
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      {accounts.length > 0 && (
        <label className="text-xs text-text-muted">{t('cost.accounts.account')}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
            className="ms-1 rounded border border-border bg-surface px-2 py-1 text-sm">
            <option value="">{t('cost.accounts.defaultOpt')}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.path} · {a.name}</option>)}
          </select>
        </label>
      )}
      {extra}
      <button type="submit" disabled={disabled}
        className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50">
        {submitLabel}
      </button>
    </form>
  );
}
