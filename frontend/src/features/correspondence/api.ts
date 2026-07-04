import axios from 'axios';
import { api } from '@/lib/api';

// v1.89: correspondence (دبیرخانه) — per-project register of formal letters
// with parties, dates, attachments, referral routing. Module is enabled per
// project by a global admin.

export type LetterDirection = 'INCOMING' | 'OUTGOING' | 'INTERNAL';
export type LetterStatus = 'DRAFT' | 'SENT' | 'RECEIVED' | 'ARCHIVED';
export type ReferralKind = 'ACTION' | 'INFO';
export type ReferralStatus = 'PENDING' | 'HANDLED';

// v2.5.26 (W2.2): a task created from / linked to a letter.
export interface LinkedTask {
  taskId: string;
  title: string;
  status: string;
}

// v2.5.26 (W2.2): parent-letter summary shown in a reply thread.
export interface ReplyToSummary {
  id: string;
  referenceNumber: string;
  subject: string;
}

export interface Letter {
  id: string;
  projectId: string;
  teamId: string;
  referenceNumber: string;
  subject: string;
  body: string;
  direction: LetterDirection;
  letterDate: string; // ISO (UTC-midnight calendar date)
  senderId: string | null;
  senderName?: string | null;
  recipientId: string | null;
  recipientName?: string | null;
  status: LetterStatus;
  attachmentCount: number;
  hasReferrals?: boolean;
  // Backend returns referrals inline on the letter (no separate list route).
  referrals?: Referral[];
  // v2.5.26 (W2.2): external correspondent's own ref/date, reply-to thread, links.
  externalReferenceNumber: string | null;
  externalDate: string | null;
  replyToId: string | null;
  replyTo: ReplyToSummary | null;
  linkedTasks: LinkedTask[];
  createdAt: string;
  updatedAt: string;
}

export interface LetterInput {
  subject: string;
  body: string;
  direction: LetterDirection;
  letterDate: string | null;
  senderId: string | null;
  recipientId: string | null;
  status: LetterStatus;
  // v2.5.26 (W2.2): optional tier-1 fields.
  externalReferenceNumber?: string | null;
  externalDate?: string | null;
  replyToId?: string | null;
}

export interface Referral {
  id: string;
  userId: string;
  userName: string;
  kind: ReferralKind;
  note: string | null;
  status: ReferralStatus;
  // v2.5.26 (W2.2): optional action deadline.
  dueAt: string | null;
  createdAt: string;
  handledAt: string | null;
}

export interface ReferralInput {
  userId: string;
  kind: ReferralKind;
  note?: string;
  dueAt?: string | null;
}

// v2.5.26 (W2.2): a row in the cross-project "My referrals" inbox.
export interface MyReferral {
  id: string;
  correspondenceId: string;
  kind: ReferralKind;
  note: string | null;
  status: ReferralStatus;
  dueAt: string | null;
  createdAt: string;
  handledAt: string | null;
  teamId: string;
  projectId: string;
  referenceNumber: string;
  subject: string;
  direction: LetterDirection;
  letterDate: string;
}

// Forked from the task AttachmentsSection — correspondence attachments live
// under the letter route, not the task route.
export interface CorrespondenceAttachment {
  id: string;
  correspondenceId: string;
  uploaderId: string;
  uploaderName: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface LetterFilters {
  direction?: LetterDirection | '';
  status?: LetterStatus | '';
  search?: string;
  // v2.5.30 (W2.3): cursor pagination.
  limit?: number;
  cursor?: string;
}

export interface LetterPage {
  items: Letter[];
  nextCursor: string | null;
}

function base(teamId: string, projectId: string): string {
  return `/teams/${teamId}/projects/${projectId}/correspondence`;
}

export async function listLetters(
  teamId: string,
  projectId: string,
  filters: LetterFilters = {},
): Promise<LetterPage> {
  const params: Record<string, string> = {};
  if (filters.direction) params.direction = filters.direction;
  if (filters.status) params.status = filters.status;
  if (filters.search) params.search = filters.search;
  if (filters.limit) params.limit = String(filters.limit);
  if (filters.cursor) params.cursor = filters.cursor;
  return (await api.get<LetterPage>(base(teamId, projectId), { params })).data;
}

export async function getLetter(
  teamId: string,
  projectId: string,
  id: string,
): Promise<Letter> {
  return (await api.get<Letter>(`${base(teamId, projectId)}/${id}`)).data;
}

export async function createLetter(
  teamId: string,
  projectId: string,
  input: LetterInput,
): Promise<Letter> {
  return (await api.post<Letter>(base(teamId, projectId), input)).data;
}

export async function updateLetter(
  teamId: string,
  projectId: string,
  id: string,
  input: Partial<LetterInput>,
): Promise<Letter> {
  return (await api.patch<Letter>(`${base(teamId, projectId)}/${id}`, input)).data;
}

export async function deleteLetter(
  teamId: string,
  projectId: string,
  id: string,
): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/${id}`);
}

export async function setLetterStatus(
  teamId: string,
  projectId: string,
  id: string,
  status: LetterStatus,
): Promise<Letter> {
  return (await api.patch<Letter>(`${base(teamId, projectId)}/${id}/status`, { status })).data;
}

// --- Referrals (ارجاع) ---

export async function listReferrals(
  teamId: string,
  projectId: string,
  id: string,
): Promise<Referral[]> {
  // The backend returns referrals inline on the letter; there is no list route.
  return (await getLetter(teamId, projectId, id)).referrals ?? [];
}

export async function referLetter(
  teamId: string,
  projectId: string,
  id: string,
  targets: ReferralInput[],
): Promise<Letter> {
  return (
    await api.post<Letter>(`${base(teamId, projectId)}/${id}/referrals`, { targets })
  ).data;
}

export async function handleReferral(
  teamId: string,
  projectId: string,
  id: string,
  referralId: string,
): Promise<Referral> {
  return (
    await api.post<Referral>(`${base(teamId, projectId)}/${id}/referrals/${referralId}/handle`)
  ).data;
}

// --- Attachments (forked from features/attachments) ---

export async function listLetterAttachments(
  teamId: string,
  projectId: string,
  letterId: string,
): Promise<CorrespondenceAttachment[]> {
  return (
    await api.get<CorrespondenceAttachment[]>(
      `${base(teamId, projectId)}/${letterId}/attachments`,
    )
  ).data;
}

export async function uploadLetterAttachment(
  teamId: string,
  projectId: string,
  letterId: string,
  file: File,
): Promise<CorrespondenceAttachment> {
  const fd = new FormData();
  fd.append('file', file);
  return (
    await api.post<CorrespondenceAttachment>(
      `${base(teamId, projectId)}/${letterId}/attachments`,
      fd,
    )
  ).data;
}

export async function deleteLetterAttachment(
  teamId: string,
  projectId: string,
  letterId: string,
  attachmentId: string,
): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/${letterId}/attachments/${attachmentId}`);
}

export async function downloadLetterAttachment(
  teamId: string,
  projectId: string,
  letterId: string,
  attachment: CorrespondenceAttachment,
): Promise<void> {
  const urlPath = `${base(teamId, projectId)}/${letterId}/attachments/${attachment.id}`;
  const res = await api.get<Blob>(urlPath, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Linked tasks (letter ↔ task bridge, W2.2) ---

export interface CreateLinkedTaskInput {
  title: string;
  description?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueDate?: string | null;
  assigneeId?: string | null;
}

export async function listLinkedTasks(
  teamId: string,
  projectId: string,
  id: string,
): Promise<LinkedTask[]> {
  return (
    await api.get<{ items: LinkedTask[] }>(`${base(teamId, projectId)}/${id}/tasks`)
  ).data.items;
}

export async function createLinkedTask(
  teamId: string,
  projectId: string,
  id: string,
  input: CreateLinkedTaskInput,
): Promise<LinkedTask[]> {
  return (
    await api.post<{ items: LinkedTask[] }>(`${base(teamId, projectId)}/${id}/tasks`, input)
  ).data.items;
}

// --- Cross-project "My referrals" inbox (W2.2) ---

export interface MyReferralsQuery {
  status?: ReferralStatus;
  due?: 'overdue' | 'week' | 'all';
}

export async function listMyReferrals(q: MyReferralsQuery = {}): Promise<MyReferral[]> {
  const params: Record<string, string> = {};
  if (q.status) params.status = q.status;
  if (q.due) params.due = q.due;
  return (await api.get<{ items: MyReferral[] }>('/me/referrals', { params })).data.items;
}

// Shared axios error-message extractor (forked from AttachmentsSection).
export function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}
