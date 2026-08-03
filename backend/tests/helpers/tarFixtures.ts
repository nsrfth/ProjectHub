import { gzipSync } from 'node:zlib';

// v2.23.3 (S-13): a byte-level tar writer for the backup-bundle tests.
//
// Deliberately hand-rolled instead of shelling out to `tar`: the security
// assertions must hold regardless of which tar implementation the host
// ships (GNU, bsdtar, busybox), and several fixtures are archives no
// well-behaved tar would agree to write in the first place (traversal
// names, device nodes, smuggled long-name headers).

export interface TarMember {
  name: string;
  /**
   * POSIX tar typeflag: '0' regular, '5' directory, '1' hard link,
   * '2' symlink, '3' char device, '4' block device, '6' fifo,
   * 'L' GNU long name, 'x' pax extended header.
   */
  type?: string;
  body?: string;
  linkname?: string;
}

function octalField(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(m: TarMember): Buffer {
  const buf = Buffer.alloc(512);
  const body = m.body ?? '';
  buf.write(m.name.slice(0, 100), 0, 'utf8');
  buf.write(octalField(0o644, 8), 100, 'ascii'); // mode
  buf.write(octalField(0, 8), 108, 'ascii'); // uid
  buf.write(octalField(0, 8), 116, 'ascii'); // gid
  buf.write(octalField(Buffer.byteLength(body), 12), 124, 'ascii');
  buf.write(octalField(0, 12), 136, 'ascii'); // mtime
  buf.write('        ', 148, 'ascii'); // checksum placeholder = 8 spaces
  buf.write(m.type ?? '0', 156, 'ascii');
  if (m.linkname) buf.write(m.linkname.slice(0, 100), 157, 'utf8');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  // 6 octal digits, NUL, space — the canonical tar checksum encoding.
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return buf;
}

export function buildTar(members: TarMember[]): Buffer {
  const chunks: Buffer[] = [];
  for (const m of members) {
    chunks.push(header(m));
    const body = Buffer.from(m.body ?? '', 'utf8');
    if (body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      chunks.push(padded);
    }
  }
  chunks.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return Buffer.concat(chunks);
}

export function buildTarGz(members: TarMember[]): Buffer {
  return gzipSync(buildTar(members));
}

/** The layout a v1.32.3+ backup actually produces. */
export const VALID_BUNDLE: TarMember[] = [
  { name: './', type: '5' },
  { name: './database.dump', body: 'PGDMP-ish bytes' },
  { name: './manifest.json', body: '{"version":1}' },
  { name: './secrets.env', body: 'MASTER_KEY=deadbeef\n' },
  { name: './uploads/', type: '5' },
  { name: './uploads/abc123-file.pdf', body: 'blob' },
];
