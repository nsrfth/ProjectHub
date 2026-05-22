import { z } from 'zod';

// MIME allowlist for uploads. Deliberately narrow — adding new types should be
// a conscious decision, not an oversight. The list trades flexibility for
// "can't accidentally serve an attacker-controlled HTML/JS/SVG payload".
//
// Note: image/svg+xml is intentionally NOT included. SVG can carry inline
// <script>, which the browser would execute in the same origin when the file
// is fetched. Re-enabling it requires either rewriting the file server-side
// or serving downloads from a separate origin.
export const ALLOWED_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/zip',
  'application/json',
]);

export const attachmentResponse = z.object({
  id: z.string(),
  taskId: z.string(),
  uploaderId: z.string(),
  uploaderName: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
