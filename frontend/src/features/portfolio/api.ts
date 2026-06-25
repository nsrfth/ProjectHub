import { api } from '@/lib/api';

// v1.99 (PMIS R3 — portfolio / program): typed client for the org-unit tree,
// project attach, and subtree roll-up reports.

export type OrgUnitType = 'HOLDING' | 'PORTFOLIO' | 'PROGRAM';

export interface OrgUnit {
  id: string;
  parentId: string | null;
  type: OrgUnitType;
  name: string;
  code: string;
  path: string;
  managerId: string | null;
  managerName: string | null;
  currency: string | null;
  childCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrgUnitTreeNode extends OrgUnit {
  children: OrgUnitTreeNode[];
}

export interface PortfolioSummary {
  orgUnitId: string;
  orgUnitName: string;
  projectCount: number;
  activeCount: number;
  onHoldCount: number;
  archivedCount: number;
  openTaskCount: number;
  overdueTaskCount: number;
}

export interface PortfolioProgress {
  orgUnitId: string;
  orgUnitName: string;
  projectCount: number;
  avgPercentComplete: number;
  projects: Array<{
    projectId: string;
    projectName: string;
    teamId: string;
    teamName: string;
    percentComplete: number;
  }>;
}

export interface PortfolioRag {
  orgUnitId: string;
  orgUnitName: string;
  projectCount: number;
  byStatus: { GREEN: number; AMBER: number; RED: number };
}

export interface PortfolioCost {
  orgUnitId: string;
  orgUnitName: string;
  projectCount: number;
  rollupByCurrency: Array<{
    currency: string;
    projectCount: number;
    projectsWithBudget: number;
    totalPlanned: string | null;
  }>;
}

export async function listOrgUnitTree(): Promise<OrgUnitTreeNode[]> {
  return (await api.get<{ items: OrgUnitTreeNode[] }>('/org-units/tree')).data.items;
}

export async function createOrgUnit(input: {
  parentId?: string | null;
  type: OrgUnitType;
  name: string;
  code: string;
}): Promise<OrgUnit> {
  return (await api.post<OrgUnit>('/org-units', input)).data;
}

export async function getPortfolioSummary(orgUnitId: string): Promise<PortfolioSummary> {
  return (await api.get<PortfolioSummary>(`/org-units/${orgUnitId}/reports/summary`)).data;
}

export async function getPortfolioProgress(orgUnitId: string): Promise<PortfolioProgress> {
  return (await api.get<PortfolioProgress>(`/org-units/${orgUnitId}/reports/progress`)).data;
}

export async function getPortfolioRag(orgUnitId: string): Promise<PortfolioRag> {
  return (await api.get<PortfolioRag>(`/org-units/${orgUnitId}/reports/rag`)).data;
}

export async function getPortfolioCost(orgUnitId: string): Promise<PortfolioCost> {
  return (await api.get<PortfolioCost>(`/org-units/${orgUnitId}/reports/cost`)).data;
}

export async function setProjectOrgUnit(
  teamId: string,
  projectId: string,
  orgUnitId: string | null,
): Promise<{ projectId: string; orgUnitId: string | null; orgUnitName: string | null }> {
  return (
    await api.put(`/teams/${teamId}/projects/${projectId}/org-unit`, { orgUnitId })
  ).data;
}
