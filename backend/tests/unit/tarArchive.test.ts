import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArchiveValidationError,
  assertExtractedTreeIsSafe,
  inspectBackupArchive,
  normaliseEntryPath,
} from '../../src/lib/tarArchive.js';
import { VALID_BUNDLE, buildTarGz, type TarMember } from '../helpers/tarFixtures.js';

// v2.23.3 (S-13): backup-bundle validation.
//
// The restore flow used to hand an admin-uploaded tarball straight to
// `tar -xzf`, trusting the host tar to refuse traversal and links. These
// tests build hostile archives byte by byte (no tar binary involved, so
// the assertions hold identically on GNU tar, bsdtar and busybox hosts)
// and prove each one is refused BEFORE anything is extracted.

async function writeArchive(members: TarMember[]): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'taskhub-tar-test-'));
  const path = join(dir, 'bundle.tar.gz');
  await fs.writeFile(path, buildTarGz(members));
  return path;
}

describe('S-13 backup archive validation', () => {
  it('accepts the documented bundle layout', async () => {
    const path = await writeArchive(VALID_BUNDLE);
    const entries = await inspectBackupArchive(path);
    expect(entries.map((e) => e.path)).toEqual([
      '',
      'database.dump',
      'manifest.json',
      'secrets.env',
      'uploads',
      'uploads/abc123-file.pdf',
    ]);
    expect(entries.find((e) => e.path === 'database.dump')!.type).toBe('file');
  });

  it('accepts a .dump-only bundle (no uploads, no secrets)', async () => {
    const path = await writeArchive([
      { name: './', type: '5' },
      { name: './database.dump', body: 'x' },
      { name: './manifest.json', body: '{}' },
    ]);
    await expect(inspectBackupArchive(path)).resolves.toHaveLength(3);
  });

  const REJECTED: Array<[string, TarMember[], RegExp]> = [
    [
      'a ../ traversal entry',
      [{ name: '../../etc/cron.d/pwn', body: '* * * * * root sh' }],
      /escapes the bundle root/i,
    ],
    [
      'a traversal hidden mid-path',
      [{ name: './uploads/../../etc/passwd', body: 'x' }],
      /escapes the bundle root/i,
    ],
    [
      'an absolute path',
      [{ name: '/etc/passwd', body: 'x' }],
      /absolute path/i,
    ],
    [
      'a symlink',
      [{ name: './uploads/link', type: '2', linkname: '/home/taskhub/.ssh/authorized_keys' }],
      /non-regular member/i,
    ],
    [
      'a hard link',
      [{ name: './uploads/hard', type: '1', linkname: '/etc/shadow' }],
      /non-regular member/i,
    ],
    [
      'a character device',
      [{ name: './uploads/dev', type: '3' }],
      /non-regular member/i,
    ],
    [
      'a fifo',
      [{ name: './uploads/pipe', type: '6' }],
      /non-regular member/i,
    ],
    [
      'a stray top-level file',
      [{ name: './database.dump', body: 'x' }, { name: './evil.sh', body: '#!/bin/sh' }],
      /unexpected file/i,
    ],
    [
      'a stray top-level directory',
      [{ name: './database.dump', body: 'x' }, { name: './etc/', type: '5' }],
      /unexpected/i,
    ],
    [
      'a duplicate member',
      [
        { name: './database.dump', body: 'x' },
        { name: './database.dump', body: 'y' },
      ],
      /duplicate member/i,
    ],
    [
      'a GNU long-name header smuggling a traversal path',
      [
        { name: './@LongLink', type: 'L', body: '../../etc/cron.d/pwn\0' },
        { name: './harmless', body: 'x' },
      ],
      /escapes the bundle root/i,
    ],
    [
      'a pax header smuggling an absolute path',
      [
        { name: './PaxHeaders/0', type: 'x', body: '20 path=/etc/passwd\n' },
        { name: './harmless', body: 'x' },
      ],
      /absolute path/i,
    ],
  ];

  for (const [label, members, pattern] of REJECTED) {
    it(`rejects ${label}`, async () => {
      const path = await writeArchive(members);
      await expect(inspectBackupArchive(path)).rejects.toThrow(ArchiveValidationError);
      await expect(inspectBackupArchive(path)).rejects.toThrow(pattern);
    });
  }

  it('rejects a file that is not a gzip stream at all', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'taskhub-tar-test-'));
    const path = join(dir, 'bundle.tar.gz');
    await fs.writeFile(path, 'definitely not a tarball');
    await expect(inspectBackupArchive(path)).rejects.toThrow(ArchiveValidationError);
  });

  it('rejects a gzip stream whose tar headers are corrupt', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'taskhub-tar-test-'));
    const path = join(dir, 'bundle.tar.gz');
    const junk = Buffer.alloc(1024, 0x41);
    await fs.writeFile(path, gzipSync(junk));
    await expect(inspectBackupArchive(path)).rejects.toThrow(/checksum|numeric|corrupt/i);
  });

  it('normaliseEntryPath strips ./ and refuses the hostile shapes', () => {
    expect(normaliseEntryPath('./uploads/a.png')).toBe('uploads/a.png');
    expect(normaliseEntryPath('./')).toBe('');
    expect(normaliseEntryPath('uploads/')).toBe('uploads');
    expect(() => normaliseEntryPath('/abs')).toThrow(ArchiveValidationError);
    expect(() => normaliseEntryPath('a/../../b')).toThrow(ArchiveValidationError);
    expect(() => normaliseEntryPath('C:\\windows')).toThrow(ArchiveValidationError);
    expect(() => normaliseEntryPath('a\0b')).toThrow(ArchiveValidationError);
  });
});

describe('S-13 post-extraction tree check', () => {
  it('accepts a plain tree of files and directories', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'taskhub-extracted-'));
    await fs.mkdir(join(root, 'uploads'));
    await fs.writeFile(join(root, 'database.dump'), 'x');
    await fs.writeFile(join(root, 'uploads', 'a.bin'), 'y');
    await expect(assertExtractedTreeIsSafe(root)).resolves.toBeUndefined();
  });

  it('refuses a tree containing a symlink, however it got there', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'taskhub-extracted-'));
    await fs.writeFile(join(root, 'database.dump'), 'x');
    await fs.symlink('/etc/passwd', join(root, 'sneaky'));
    await expect(assertExtractedTreeIsSafe(root)).rejects.toThrow(/symlink/i);
  });
});
