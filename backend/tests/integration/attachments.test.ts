import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;
let uploadDir: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';

  // Use a real temp dir so the service actually writes/deletes files, but the
  // dir disappears with afterAll so the test machine stays clean.
  uploadDir = mkdtempSync(path.join(os.tmpdir(), 'taskhub-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  // Small max — exercises the truncation path without huge memory cost.
  process.env.UPLOAD_MAX_BYTES = '4096';

  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function setup(slug = 'team-att') {
  const owner = await register('owner@example.com');
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'T', slug },
    })
  ).json();
  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'P' },
    })
  ).json();
  const task = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'T' },
    })
  ).json();
  return { owner, teamId: team.id, projectId: project.id, taskId: task.id };
}

// Build a multipart/form-data payload body and headers for inject(). We avoid
// pulling in a full library — the boundary and CRLF-separated parts are short
// enough to write by hand and keeps the tests self-contained.
function multipart(
  filename: string,
  mimeType: string,
  body: Buffer | string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----taskhub-test-${Math.random().toString(36).slice(2)}`;
  const fileBytes = typeof body === 'string' ? Buffer.from(body) : body;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, fileBytes, footer]);
  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length),
    },
  };
}

describe('POST /api/.../attachments', () => {
  it('uploads a small text file and returns metadata', async () => {
    const s = await setup();
    const { payload, headers } = multipart('hello.txt', 'text/plain', 'hello world');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
      headers: { ...headers, authorization: `Bearer ${s.owner.token}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.filename).toBe('hello.txt');
    expect(body.mimeType).toBe('text/plain');
    expect(body.sizeBytes).toBe(11);
    expect(body.uploaderName).toBe('owner');
  });

  it('rejects a disallowed MIME type with 400', async () => {
    const s = await setup();
    const { payload, headers } = multipart('evil.exe', 'application/x-msdownload', 'MZ\x00');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
      headers: { ...headers, authorization: `Bearer ${s.owner.token}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized file with 400 (truncated by multipart limit)', async () => {
    const s = await setup();
    // Limit is 4096 bytes (set in beforeAll) — write 5000.
    const big = Buffer.alloc(5000, 0x41);
    const { payload, headers } = multipart('big.txt', 'text/plain', big);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
      headers: { ...headers, authorization: `Bearer ${s.owner.token}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the parent task chain is wrong', async () => {
    const s = await setup();
    const otherProject = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects`,
        headers: { authorization: `Bearer ${s.owner.token}` },
        payload: { name: 'P2' },
      })
    ).json();
    const { payload, headers } = multipart('a.txt', 'text/plain', 'x');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${otherProject.id}/tasks/${s.taskId}/attachments`,
      headers: { ...headers, authorization: `Bearer ${s.owner.token}` },
      payload,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/.../attachments and download', () => {
  it('lists attachments and streams the binary back on download', async () => {
    const s = await setup();
    const content = 'the quick brown fox';
    const { payload, headers } = multipart('fox.txt', 'text/plain', content);
    const uploaded = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
        headers: { ...headers, authorization: `Bearer ${s.owner.token}` },
        payload,
      })
    ).json();

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
      headers: { authorization: `Bearer ${s.owner.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const dl = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments/${uploaded.id}/download`,
      headers: { authorization: `Bearer ${s.owner.token}` },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('text/plain');
    expect(dl.headers['content-disposition']).toContain('fox.txt');
    expect(dl.body).toBe(content);
  });
});

describe('DELETE /api/.../attachments/:id', () => {
  it('lets the uploader delete their own attachment', async () => {
    const s = await setup();
    const { payload, headers } = multipart('mine.txt', 'text/plain', 'mine');
    const att = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
        headers: { ...headers, authorization: `Bearer ${s.owner.token}` },
        payload,
      })
    ).json();
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments/${att.id}`,
      headers: { authorization: `Bearer ${s.owner.token}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('forbids a MEMBER from deleting someone elses attachment but lets the MANAGER do it', async () => {
    const s = await setup();
    // Add a MEMBER and a second MANAGER (in addition to s.owner who created the team).
    const member = await register('member@example.com');
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/members`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { email: 'member@example.com', role: 'MEMBER' },
    });

    // Member uploads.
    const { payload, headers } = multipart('member.txt', 'text/plain', 'm');
    const att = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments`,
        headers: { ...headers, authorization: `Bearer ${member.token}` },
        payload,
      })
    ).json();

    // Add a second member as well so we can test the MEMBER-vs-MEMBER case.
    const otherMember = await register('other@example.com');
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/members`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { email: 'other@example.com', role: 'MEMBER' },
    });

    // otherMember tries to delete member's attachment — 403.
    const denied = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments/${att.id}`,
      headers: { authorization: `Bearer ${otherMember.token}` },
    });
    expect(denied.statusCode).toBe(403);

    // owner (MANAGER) succeeds.
    const ok = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/attachments/${att.id}`,
      headers: { authorization: `Bearer ${s.owner.token}` },
    });
    expect(ok.statusCode).toBe(204);
  });
});
