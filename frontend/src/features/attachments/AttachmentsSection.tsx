import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as attApi from './api';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { formatShamsiDateTime } from '@/lib/shamsi';

// Pretty-print a byte count (e.g. 1024 → "1 KB"). Tight precision is fine for
// a UI hint; if you need real accuracy go fetch the integer.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

interface AttachmentsSectionProps {
  teamId: string;
  projectId: string;
  taskId: string;
}

export function AttachmentsSection({
  teamId,
  projectId,
  taskId,
}: AttachmentsSectionProps): JSX.Element {
  const { user } = useAuth();
  const { currentTeam } = useTeams();
  const qc = useQueryClient();
  const isManager = currentTeam?.myRole === 'MANAGER';

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { data: attachments = [], isLoading } = useQuery({
    queryKey: ['attachments', taskId],
    queryFn: () => attApi.listAttachments(teamId, projectId, taskId),
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => attApi.uploadAttachment(teamId, projectId, taskId, file),
    onSuccess: async () => {
      setUploadError(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await qc.invalidateQueries({ queryKey: ['attachments', taskId] });
    },
    onError: (err) => setUploadError(errorMessage(err, 'Upload failed')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => attApi.deleteAttachment(teamId, projectId, taskId, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['attachments', taskId] });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-600">Attachments</h3>
        {attachments.length > 0 && (
          <span className="text-xs text-slate-500">{attachments.length}</span>
        )}
      </div>

      {isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {!isLoading && attachments.length === 0 && (
        <p className="text-xs text-slate-400 italic">No attachments.</p>
      )}

      <ul className="space-y-2">
        {attachments.map((a) => {
          const canDelete = a.uploaderId === user?.id || isManager;
          return (
            <li
              key={a.id}
              className="flex items-center justify-between gap-2 text-sm rounded border border-slate-200 px-2 py-1.5"
            >
              <button
                type="button"
                onClick={() => attApi.downloadAttachment(teamId, projectId, taskId, a).catch(() => {})}
                className="text-left flex-1 min-w-0 hover:underline"
                title={`${a.mimeType} · ${formatBytes(a.sizeBytes)}`}
              >
                <span className="font-medium block truncate">{a.filename}</span>
                <span className="text-xs text-slate-500">
                  {formatBytes(a.sizeBytes)} · {a.uploaderName} ·{' '}
                  <span dir="rtl">{formatShamsiDateTime(a.createdAt)}</span>
                </span>
              </button>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete "${a.filename}"?`)) deleteMut.mutate(a.id);
                  }}
                  className="text-xs text-red-600 hover:underline shrink-0"
                  aria-label={`Delete attachment ${a.filename}`}
                >
                  Delete
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadMut.mutate(f);
          }}
          className="text-xs"
          disabled={uploadMut.isPending}
        />
        {uploadMut.isPending && <span className="text-xs text-slate-500">Uploading…</span>}
      </div>
      {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
    </div>
  );
}
