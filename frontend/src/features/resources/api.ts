import { api } from '@/lib/api';

// v2.2 (PMIS R6 — resource management): typed client for the team resource catalog,
// skill catalog and workload report.
// Mirrors backend/src/schemas/resources.ts shapes.

export type ResourceType = 'HUMAN' | 'EQUIPMENT' | 'MATERIAL';
export type BudgetCurrency = 'IRR' | 'USD' | 'EUR';

export interface ResourceSkill {
  skillId: string;
  skillName: string;
  level: number;
}

export interface Resource {
  id: string;
  teamId: string;
  name: string;
  type: ResourceType;
  userId: string | null;
  email: string | null;
  maxUnits: number;
  costRateMinor: number | null;
  currency: BudgetCurrency | null;
  calendarId: string | null;
  notes: string | null;
  skills: ResourceSkill[];
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  teamId: string;
  name: string;
  createdAt: string;
}

export interface WorkloadItem {
  resourceId: string;
  resourceName: string;
  totalPlannedHours: number;
  totalActualHours: number;
  assignmentCount: number;
}

export interface CreateResourceInput {
  name: string;
  type?: ResourceType;
  userId?: string | null;
  email?: string | null;
  maxUnits?: number;
  costRateMinor?: number | null;
  currency?: BudgetCurrency | null;
  notes?: string | null;
}

export async function listResources(teamId: string): Promise<Resource[]> {
  return (await api.get<{ items: Resource[] }>(`/teams/${teamId}/resources`)).data.items;
}
export async function createResource(teamId: string, input: CreateResourceInput): Promise<Resource> {
  return (await api.post<Resource>(`/teams/${teamId}/resources`, input)).data;
}
export async function deleteResource(teamId: string, id: string): Promise<void> {
  await api.delete(`/teams/${teamId}/resources/${id}`);
}

export async function listSkills(teamId: string): Promise<Skill[]> {
  return (await api.get<{ items: Skill[] }>(`/teams/${teamId}/skills`)).data.items;
}
export async function createSkill(teamId: string, name: string): Promise<Skill> {
  return (await api.post<Skill>(`/teams/${teamId}/skills`, { name })).data;
}
export async function deleteSkill(teamId: string, id: string): Promise<void> {
  await api.delete(`/teams/${teamId}/skills/${id}`);
}

export async function getWorkload(teamId: string): Promise<WorkloadItem[]> {
  return (await api.get<{ items: WorkloadItem[] }>(`/teams/${teamId}/resources/workload`)).data.items;
}
