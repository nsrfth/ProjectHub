import { createReadStream, promises as fs } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { join, resolve as resolvePath, sep } from 'node:path';

// v2.23.3 (S-13): tar bundle validation for the backup-restore flow.
//
// A restore takes an admin-uploaded `.tar.gz` and unpacks it into a
// staging directory. Handing an attacker-supplied archive straight to
// `tar -xzf` trusts the host tar's own hardening: entries named
// `../../etc/cron.d/x`, absolute paths, or a symlink `uploads/x ->
// /home/taskhub/.ssh` that a later entry writes *through* all become
// writes outside staging. GNU tar refuses some of these; bsdtar refuses
// a different set; neither promise is something we should depend on.
//
// So we parse the archive OURSELVES before extraction and accept only
// the documented bundle shape:
//
//     ./                      (the archive root, as `tar -C dir .` writes it)
//     database.dump           regular file, required
//     manifest.json           regular file
//     secrets.env             regular file, optional
//     uploads/                directory, optional
//     uploads/**              regular files + directories only
//
// Anything else — symlink, hard link, device node, fifo, absolute path,
// `..` segment, unknown top-level name — fails the whole archive before
// a single byte is written to disk, and therefore before the live schema
// is touched.
//
// This is a reader, not an extractor: it validates then lets `tar` do
// the unpacking (with ownership/permission restoration disabled), and
// the caller re-walks the staging tree afterwards to confirm nothing
// unexpected landed. Two independent checks, cheap ones.

const BLOCK = 512;

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

export interface TarEntry {
  /** Normalised path, no leading `./`, `/`-separated. '' is the root dir. */
  path: string;
  type: 'file' | 'dir';
  size: number;
}

export interface InspectOptions {
  /** Runaway guard: a bundle with more members than this is refused. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200_000;

// Top-level members the bundle format defines. Everything else is a
// refusal — including dot-files, which have no place in a backup bundle.
const ALLOWED_ROOT_FILES = new Set(['database.dump', 'manifest.json', 'secrets.env']);
const UPLOADS_ROOT = 'uploads';

function octal(buf: Buffer, offset: number, length: number): number {
  // Tar numeric fields are NUL/space-padded octal ASCII. GNU base-256
  // encoding (high bit set) is used only for >8 GiB members / large
  // uids; we refuse it rather than implement it — a single backup member
  // that big is not a shape this app produces.
  const raw = buf.subarray(offset, offset + length);
  if (raw.length > 0 && (raw[0]! & 0x80) !== 0) {
    throw new ArchiveValidationError('Archive uses base-256 numeric fields (unsupported)');
  }
  const text = raw.toString('ascii').replace(/\0/g, ' ').trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new ArchiveValidationError(`Archive has a malformed numeric header field: ${text}`);
  }
  return parseInt(text, 8);
}

function cstring(buf: Buffer, offset: number, length: number): string {
  const raw = buf.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

// Header checksum: sum of all header bytes with the checksum field read
// as spaces. Cheap, and it catches "this isn't really a tar" long before
// we hand the file to tar(1).
function checksumMatches(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

// Normalise a tar member name into a repo-relative POSIX path, or throw.
export function normaliseEntryPath(raw: string): string {
  if (raw.includes('\0')) throw new ArchiveValidationError('Archive entry name contains NUL');
  if (raw.includes('\\')) {
    throw new ArchiveValidationError(`Archive entry uses a backslash path: ${raw}`);
  }
  if (raw.startsWith('/')) {
    throw new ArchiveValidationError(`Archive entry has an absolute path: ${raw}`);
  }
  if (/^[A-Za-z]:/.test(raw)) {
    throw new ArchiveValidationError(`Archive entry has a drive-letter path: ${raw}`);
  }
  let path = raw;
  while (path.startsWith('./')) path = path.slice(2);
  if (path === '.') path = '';
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new ArchiveValidationError(`Archive entry escapes the bundle root: ${raw}`);
    }
    if (seg === '' || seg === '.') {
      throw new ArchiveValidationError(`Archive entry has an empty path segment: ${raw}`);
    }
  }
  return segments.join('/');
}

// Enforce the documented bundle layout.
function assertAllowedMember(entry: TarEntry): void {
  if (entry.path === '') {
    if (entry.type !== 'dir') {
      throw new ArchiveValidationError('Archive root member is not a directory');
    }
    return;
  }
  const segments = entry.path.split('/');
  const head = segments[0]!;
  if (segments.length === 1) {
    if (entry.type === 'dir') {
      if (head !== UPLOADS_ROOT) {
        throw new ArchiveValidationError(`Archive contains an unexpected directory: ${entry.path}`);
      }
      return;
    }
    if (!ALLOWED_ROOT_FILES.has(head)) {
      throw new ArchiveValidationError(`Archive contains an unexpected file: ${entry.path}`);
    }
    return;
  }
  if (head !== UPLOADS_ROOT) {
    throw new ArchiveValidationError(`Archive contains an unexpected member: ${entry.path}`);
  }
}

// Read the whole gzip stream, parsing tar headers. Payload bytes are
// skipped except for the extended-header types we understand.
export async function inspectBackupArchive(
  archivePath: string,
  opts: InspectOptions = {},
): Promise<TarEntry[]> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);

  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  // Bytes of the current member's payload still to skip (or capture).
  let skipRemaining = 0;
  let capture: { kind: 'longname' | 'pax'; chunks: Buffer[]; remaining: number } | null = null;
  let overridePath: string | null = null;
  let zeroBlocks = 0;
  let ended = false;

  const consumeHeader = (header: Buffer): void => {
    if (header.every((b) => b === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) ended = true;
      return;
    }
    zeroBlocks = 0;
    if (!checksumMatches(header)) {
      throw new ArchiveValidationError('Archive has a corrupt tar header (checksum mismatch)');
    }
    const typeflag = String.fromCharCode(header[156]!);
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    // GNU long-name ('L') and pax extended ('x'/'g') headers carry the
    // real path of the NEXT member in their payload. We capture those
    // payloads so the name we validate is the effective one — validating
    // the 100-byte truncated name instead would be exactly the bypass
    // this function exists to prevent.
    if (typeflag === 'L' || typeflag === 'x' || typeflag === 'g') {
      if (size > 64 * 1024) {
        throw new ArchiveValidationError('Archive extended header is implausibly large');
      }
      capture = {
        kind: typeflag === 'L' ? 'longname' : 'pax',
        chunks: [],
        remaining: size,
      };
      skipRemaining = padded;
      return;
    }
    // 'K' is GNU LongLink — only meaningful for hard/sym links, which we
    // refuse outright. Anything not a regular file or a directory is a
    // refusal: 1=hardlink 2=symlink 3=char 4=block 6=fifo 7=contiguous.
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
      throw new ArchiveValidationError(
        `Archive contains a non-regular member (tar type '${typeflag === '\0' ? '0' : typeflag}') — ` +
          'symlinks, hard links and device nodes are not allowed in a backup bundle',
      );
    }
    const linkname = cstring(header, 157, 100);
    if (linkname.length > 0) {
      throw new ArchiveValidationError('Archive member carries a link target');
    }

    const prefix = cstring(header, 345, 155);
    const name = cstring(header, 0, 100);
    const rawPath = overridePath ?? (prefix ? `${prefix}/${name}` : name);
    overridePath = null;
    const path = normaliseEntryPath(rawPath);
    const type: TarEntry['type'] = typeflag === '5' || rawPath.endsWith('/') ? 'dir' : 'file';
    const entry: TarEntry = { path, type, size };
    assertAllowedMember(entry);
    if (path !== '' && seen.has(path)) {
      throw new ArchiveValidationError(`Archive contains a duplicate member: ${path}`);
    }
    seen.add(path);
    entries.push(entry);
    if (entries.length > maxEntries) {
      throw new ArchiveValidationError('Archive contains too many members');
    }
    skipRemaining = padded;
  };

  const applyCaptured = (): void => {
    if (!capture) return;
    const payload = Buffer.concat(capture.chunks).toString('utf8');
    if (capture.kind === 'longname') {
      overridePath = payload.replace(/\0+$/, '');
    } else {
      // pax records: "<len> key=value\n". Only `path` matters to us;
      // `linkpath` implies a link, which the type check refuses anyway.
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(payload);
      if (match) overridePath = match[1]!;
    }
    capture = null;
  };

  await new Promise<void>((resolvePromise, reject) => {
    const fail = (err: unknown): void => {
      gunzip.destroy();
      source.destroy();
      reject(err instanceof Error ? err : new ArchiveValidationError(String(err)));
    };
    gunzip.on('data', (chunk: Buffer) => {
      if (ended) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      try {
        for (;;) {
          if (ended) return;
          if (skipRemaining > 0) {
            const take = Math.min(skipRemaining, pending.length);
            if (capture && capture.remaining > 0) {
              const wanted = Math.min(capture.remaining, take);
              capture.chunks.push(pending.subarray(0, wanted));
              capture.remaining -= wanted;
            }
            pending = pending.subarray(take);
            skipRemaining -= take;
            if (skipRemaining === 0 && capture) applyCaptured();
            if (skipRemaining > 0) return;
            continue;
          }
          if (pending.length < BLOCK) return;
          const header = pending.subarray(0, BLOCK);
          pending = pending.subarray(BLOCK);
          consumeHeader(header);
        }
      } catch (err) {
        fail(err);
      }
    });
    gunzip.on('error', (err) =>
      fail(new ArchiveValidationError(`Archive is not a readable .tar.gz: ${err.message}`)),
    );
    gunzip.on('end', () => resolvePromise());
    gunzip.on('close', () => resolvePromise());
  });

  if (entries.length === 0) {
    throw new ArchiveValidationError('Archive contains no members');
  }
  return entries;
}

// Post-extraction belt-and-braces: every path under `root` must be a
// regular file or directory (no symlinks — lstat, never stat) and must
// resolve to a location inside `root`.
export async function assertExtractedTreeIsSafe(root: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new ArchiveValidationError(`Extracted archive contains a symlink: ${entry.name}`);
      }
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new ArchiveValidationError(
          `Extracted archive contains a special file: ${entry.name}`,
        );
      }
      const real = resolvePath(full);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new ArchiveValidationError(`Extracted archive escaped the staging directory: ${real}`);
      }
      if (stat.isDirectory()) await walk(full);
    }
  };
  await walk(realRoot);
}
