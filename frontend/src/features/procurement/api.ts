import { api } from '@/lib/api';

// v2.5 (PMIS R9 — procurement): typed client for vendors, contracts and POs.
// Mirrors backend/src/schemas/lifecycle.ts vendor/contract/poResponse shapes.

export type BudgetCurrency = 'IRR' | 'USD' | 'EUR';
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'CANCELLED';
export type PoStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';

export interface Vendor {
  id: string;
  teamId: string;
  name: string;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contract {
  id: string;
  teamId: string;
  projectId: string;
  vendorId: string | null;
  vendorName: string | null;
  reference: string;
  title: string;
  status: ContractStatus;
  valueMinor: number | null;
  currency: BudgetCurrency | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrder {
  id: string;
  teamId: string;
  projectId: string;
  contractId: string | null;
  reference: string;
  title: string;
  status: PoStatus;
  amountMinor: number | null;
  currency: BudgetCurrency | null;
  issuedDate: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  commitmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVendorInput {
  name: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  address?: string | null;
  notes?: string | null;
}

export interface CreateContractInput {
  title: string;
  vendorId?: string | null;
  status?: ContractStatus;
  valueMinor?: number | null;
  currency?: BudgetCurrency | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
}

export interface CreatePoInput {
  title: string;
  contractId?: string | null;
  amountMinor?: number | null;
  currency?: BudgetCurrency | null;
  issuedDate?: string | null;
  expectedDate?: string | null;
}

export interface UpdatePoInput {
  title?: string;
  status?: PoStatus;
  amountMinor?: number | null;
  currency?: BudgetCurrency | null;
  issuedDate?: string | null;
  expectedDate?: string | null;
  receivedDate?: string | null;
}

// Vendors — team-scoped
export async function listVendors(teamId: string): Promise<Vendor[]> {
  return (await api.get<{ items: Vendor[] }>(`/teams/${teamId}/vendors`)).data.items;
}
export async function createVendor(teamId: string, input: CreateVendorInput): Promise<Vendor> {
  return (await api.post<Vendor>(`/teams/${teamId}/vendors`, input)).data;
}
export async function deleteVendor(teamId: string, id: string): Promise<void> {
  await api.delete(`/teams/${teamId}/vendors/${id}`);
}

// Contracts — project-scoped
const contractBase = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/contracts`;

export async function listContracts(teamId: string, projectId: string): Promise<Contract[]> {
  return (await api.get<{ items: Contract[] }>(contractBase(teamId, projectId))).data.items;
}
export async function createContract(
  teamId: string, projectId: string, input: CreateContractInput,
): Promise<Contract> {
  return (await api.post<Contract>(contractBase(teamId, projectId), input)).data;
}

// Purchase Orders — project-scoped
const poBase = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/purchase-orders`;

export async function listPurchaseOrders(teamId: string, projectId: string): Promise<PurchaseOrder[]> {
  return (await api.get<{ items: PurchaseOrder[] }>(poBase(teamId, projectId))).data.items;
}
export async function createPurchaseOrder(
  teamId: string, projectId: string, input: CreatePoInput,
): Promise<PurchaseOrder> {
  return (await api.post<PurchaseOrder>(poBase(teamId, projectId), input)).data;
}
export async function updatePurchaseOrder(
  teamId: string, projectId: string, id: string, input: UpdatePoInput,
): Promise<PurchaseOrder> {
  return (await api.patch<PurchaseOrder>(`${poBase(teamId, projectId)}/${id}`, input)).data;
}
