import { api } from '@/lib/api';

// v2.3 (PMIS R7 — EVM): typed client for earned-value management metrics,
// snapshots and S-curve series. Mirrors backend/src/schemas/evm.ts shapes.

export type EacMethod = 'CPI_BASED' | 'SPI_BASED' | 'TCPI_BASED';
export type BudgetCurrency = 'IRR' | 'USD' | 'EUR';

export interface EvmMetrics {
  projectId: string;
  asOf: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  cv: number;
  sv: number;
  cpi: number;
  spi: number;
  eac: number;
  eacMethod: EacMethod;
  vac: number;
  tcpi: number;
  currency: BudgetCurrency;
}

export interface EvmSnapshot extends EvmMetrics {
  id: string;
  createdAt: string;
}

export interface EvmSeriesItem {
  date: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  cpi: number;
  spi: number;
}

const base = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/evm`;

export async function getEvmMetrics(
  teamId: string,
  projectId: string,
  params?: { asOf?: string; eacMethod?: EacMethod },
): Promise<EvmMetrics> {
  return (await api.get<EvmMetrics>(base(teamId, projectId), { params })).data;
}

export async function saveEvmSnapshot(
  teamId: string,
  projectId: string,
  params?: { asOf?: string; eacMethod?: EacMethod },
): Promise<EvmSnapshot> {
  return (await api.post<EvmSnapshot>(`${base(teamId, projectId)}/snapshot`, {}, { params })).data;
}

export async function getEvmSeries(
  teamId: string,
  projectId: string,
  bucket?: 'day' | 'week' | 'month',
): Promise<EvmSeriesItem[]> {
  return (
    await api.get<{ items: EvmSeriesItem[] }>(`${base(teamId, projectId)}/series`, {
      params: bucket ? { bucket } : undefined,
    })
  ).data.items;
}
