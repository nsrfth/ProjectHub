import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.30: full-text search.
//
// Covers:
//   - basic match (title / comment body / project description)
//   - title-weighted ranking ('A' on title outranks 'B' on description)
//   - cross-team isolation (THE critical test)
//   - soft-deleted exclusion (Task + Comment)
//   - per-bucket cursor pagination
//   - `type=` filter
//   - empty `q` short-circuit
//   - caller with zero memberships

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.taskDependency.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

interface AuthCtx {
  token: string;
  userId: string;
}

async function register(email: string, name = 'User'): Promise<AuthCtx> {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(
  token: string,
  teamId: string,
  name: string,
  description?: string,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name, ...(description ? { description } : {}) },
  });
  if (r.statusCode !== 201) throw new Error(`createProject: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createTask(
  token: string,
  teamId: string,
  projectId: string,
  title: string,
  description?: string,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title, ...(description ? { description } : {}) },
  });
  if (r.statusCode !== 201) throw new Error(`createTask: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createComment(
  token: string,
  teamId: string,
  projectId: string,
  taskId: string,
  body: string,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/comments`,
    headers: { authorization: `Bearer ${token}` },
    payload: { body },
  });
  if (r.statusCode !== 201) throw new Error(`createComment: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function search(
  token: string,
  query: Record<string, string | number>,
): Promise<{
  tasks: { items: Array<{ id: string; title: string; rank: number; excerpt: string | null }>; nextCursor: string | null };
  comments: { items: Array<{ id: string; taskId: string; excerpt: string; rank: number }>; nextCursor: string | null };
  projects: { items: Array<{ id: string; name: string; rank: number }>; nextCursor: string | null };
}> {
  const qs = new URLSearchParams(
    Object.entries(query).reduce<Record<string, string>>((acc, [k, v]) => {
      acc[k] = String(v);
      return acc;
    }, {}),
  ).toString();
  const r = await app.inject({
    method: 'GET',
    url: `/api/search?${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.statusCode !== 200) throw new Error(`search: ${r.statusCode} ${r.body}`);
  return r.json();
}

describe('Full-text search', () => {
  it('finds a task by title', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    await createTask(a.token, teamId, projectId, 'Deploy nightly build');
    await createTask(a.token, teamId, projectId, 'Unrelated work');

    const res = await search(a.token, { q: 'nightly' });
    expect(res.tasks.items).toHaveLength(1);
    expect(res.tasks.items[0].title).toBe('Deploy nightly build');
    // Excerpt comes from description; this task has none, so excerpt is null.
    expect(res.tasks.items[0].excerpt).toBeNull();
  });

  it('finds a comment by body, joined with the parent task title', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    const taskId = await createTask(a.token, teamId, projectId, 'Parent task');
    await createComment(a.token, teamId, projectId, taskId, 'Ship the migration today');

    const res = await search(a.token, { q: 'migration' });
    expect(res.comments.items).toHaveLength(1);
    expect(res.comments.items[0].taskId).toBe(taskId);
    expect(res.comments.items[0].excerpt).toContain('<b>migration</b>');
  });

  it('finds a project by description', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    await createProject(a.token, teamId, 'Internal Tools', 'Authentication overhaul');

    const res = await search(a.token, { q: 'authentication' });
    expect(res.projects.items).toHaveLength(1);
    expect(res.projects.items[0].name).toBe('Internal Tools');
    expect(res.projects.items[0].excerpt).toContain('<b>Authentication</b>');
  });

  it('ranks a title hit above a description-only hit (setweight A>B)', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    // Description-heavy: the term appears 3 times in description, 0 in title.
    await createTask(
      a.token,
      teamId,
      projectId,
      'Random heading',
      'kanban kanban kanban kanban',
    );
    // Title-only: term appears once, in the title.
    await createTask(a.token, teamId, projectId, 'kanban polish', undefined);

    const res = await search(a.token, { q: 'kanban' });
    expect(res.tasks.items.length).toBeGreaterThanOrEqual(2);
    // setweight bias means title hit ranks first even though description
    // version has more occurrences.
    expect(res.tasks.items[0].title).toBe('kanban polish');
    expect(res.tasks.items[0].rank).toBeGreaterThan(res.tasks.items[1].rank);
  });

  it('does NOT leak results across teams the caller is not a member of', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com', 'B');
    const teamA = await createTeam(a.token, 'team-a');
    const teamB = await createTeam(b.token, 'team-b');
    const projA = await createProject(a.token, teamA, 'PA');
    const projB = await createProject(b.token, teamB, 'PB');
    await createTask(a.token, teamA, projA, 'A-side secret deploy');
    await createTask(b.token, teamB, projB, 'B-side secret deploy');
    await createComment(
      a.token,
      teamA,
      projA,
      await createTask(a.token, teamA, projA, 'host'),
      'secret comment for A',
    );

    // User A searches; sees A's content, never B's.
    const resA = await search(a.token, { q: 'secret' });
    const aTaskTitles = resA.tasks.items.map((i) => i.title);
    expect(aTaskTitles).toContain('A-side secret deploy');
    expect(aTaskTitles).not.toContain('B-side secret deploy');
    expect(resA.comments.items.some((c) => c.excerpt.includes('secret'))).toBe(true);

    // User B searches; sees B's content, never A's.
    const resB = await search(b.token, { q: 'secret' });
    const bTaskTitles = resB.tasks.items.map((i) => i.title);
    expect(bTaskTitles).toContain('B-side secret deploy');
    expect(bTaskTitles).not.toContain('A-side secret deploy');
    expect(resB.comments.items).toEqual([]);
  });

  it('excludes soft-deleted tasks and soft-deleted comments', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    const liveTask = await createTask(a.token, teamId, projectId, 'live keyword task');
    const deletedTask = await createTask(a.token, teamId, projectId, 'deleted keyword task');
    const taskForComments = await createTask(a.token, teamId, projectId, 'comment host');
    await createComment(a.token, teamId, projectId, taskForComments, 'live keyword comment');
    const deletedComment = await createComment(
      a.token,
      teamId,
      projectId,
      taskForComments,
      'deleted keyword comment',
    );

    // Soft-delete one task + one comment.
    await prisma.task.update({
      where: { id: deletedTask },
      data: { deletedAt: new Date(), deletedById: a.userId },
    });
    await prisma.comment.update({
      where: { id: deletedComment },
      data: { deletedAt: new Date(), deletedById: a.userId },
    });

    const res = await search(a.token, { q: 'keyword' });
    const taskIds = res.tasks.items.map((i) => i.id);
    expect(taskIds).toContain(liveTask);
    expect(taskIds).not.toContain(deletedTask);
    expect(res.comments.items).toHaveLength(1);
    expect(res.comments.items[0].excerpt).toContain('live');
  });

  it('paginates per-bucket via the (rank,id) keyset cursor', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    // Create 25 tasks all matching the same term, with varying secondary
    // text so ranks differ a little (forces real cursor traversal).
    for (let i = 0; i < 25; i++) {
      await createTask(
        a.token,
        teamId,
        projectId,
        `pagination match ${i}`,
        i % 2 === 0 ? 'pagination pagination' : undefined,
      );
    }

    const page1 = await search(a.token, { q: 'pagination', limit: 10 });
    expect(page1.tasks.items).toHaveLength(10);
    expect(page1.tasks.nextCursor).not.toBeNull();

    const page2 = await search(a.token, {
      q: 'pagination',
      limit: 10,
      taskCursor: page1.tasks.nextCursor!,
    });
    expect(page2.tasks.items).toHaveLength(10);
    expect(page2.tasks.nextCursor).not.toBeNull();
    // No id appears in both pages — cursor is correct.
    const overlap = page1.tasks.items
      .map((i) => i.id)
      .filter((id) => page2.tasks.items.some((j) => j.id === id));
    expect(overlap).toEqual([]);

    const page3 = await search(a.token, {
      q: 'pagination',
      limit: 10,
      taskCursor: page2.tasks.nextCursor!,
    });
    expect(page3.tasks.items).toHaveLength(5);
    expect(page3.tasks.nextCursor).toBeNull();
  });

  it('respects the `type` filter — only the requested bucket has items', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'overlap');
    const taskId = await createTask(a.token, teamId, projectId, 'overlap title');
    await createComment(a.token, teamId, projectId, taskId, 'overlap body');

    const onlyTasks = await search(a.token, { q: 'overlap', type: 'task' });
    expect(onlyTasks.tasks.items.length).toBeGreaterThanOrEqual(1);
    expect(onlyTasks.comments.items).toEqual([]);
    expect(onlyTasks.projects.items).toEqual([]);

    const onlyComments = await search(a.token, { q: 'overlap', type: 'comment' });
    expect(onlyComments.tasks.items).toEqual([]);
    expect(onlyComments.comments.items.length).toBeGreaterThanOrEqual(1);
    expect(onlyComments.projects.items).toEqual([]);

    const onlyProjects = await search(a.token, { q: 'overlap', type: 'project' });
    expect(onlyProjects.projects.items.length).toBeGreaterThanOrEqual(1);
    expect(onlyProjects.tasks.items).toEqual([]);
    expect(onlyProjects.comments.items).toEqual([]);
  });

  it('returns empty buckets for empty q (no DB scan)', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    await createTask(a.token, teamId, projectId, 'anything');

    const res = await search(a.token, { q: '' });
    expect(res.tasks.items).toEqual([]);
    expect(res.comments.items).toEqual([]);
    expect(res.projects.items).toEqual([]);
    expect(res.tasks.nextCursor).toBeNull();
  });

  it('returns empty buckets when the caller is not in any team', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'alpha');
    const projectId = await createProject(a.token, teamId, 'P');
    await createTask(a.token, teamId, projectId, 'lonely match');
    // Second user with no memberships.
    const b = await register('lonely@example.com', 'B');
    const res = await search(b.token, { q: 'lonely' });
    expect(res.tasks.items).toEqual([]);
    expect(res.comments.items).toEqual([]);
    expect(res.projects.items).toEqual([]);
  });

  it('requires authentication (401 for an anonymous caller)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/search?q=anything' });
    expect(r.statusCode).toBe(401);
  });
});
