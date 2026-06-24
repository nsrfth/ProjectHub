import axios from 'axios';
import { api } from '@/lib/api';

// v1.89: correspondence (دبیرخانه) — per-project register of formal letters
// with parties, dates, attachments, referral routing. Module is enabled per
// project by a global admin.

export type LetterDirection = 'INCOMING' | 'OUTGOING' | 'INTERNAL';
export type LetterStatus = 'DRAFT' | 'SENT' | 'RECEIVED' | 'ARCHIVED';
export type ReferralKind = 'ACTION' | 'INFO';
export type ReferralStatus = 'PENDING' | 'HANDLED';

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
}

export interface Referral {
  id: string;
  userId: string;
  userName: string;
  kind: ReferralKind;
  note: string | null;
  status: ReferralStatus;
  createdAt: string;
  handledAt: string | null;
}

export interface ReferralInput {
  userId: string;
  kind: ReferralKind;
  note?: string;
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
}

function base(teamId: string, projectId: string): string {
  return `/teams/${teamId}/projects/${projectId}/correspondence`;
}

export async function listLetters(
  teamId: string,
  projectId: string,
  filters: LetterFilters = {},
): Promise<Letter[]> {
  const params: Record<string, string> = {};
  if (filters.direction) params.direction = filters.direction;
  if (filters.status) params.status = filters.status;
  if (filters.search) params.search = filters.search;
  return (await api.get<Letter[]>(base(teamId, projectId), { params })).data;
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

// Shared axios error-message extractor (forked from AttachmentsSection).
export function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}
