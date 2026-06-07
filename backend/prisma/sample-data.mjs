// One-shot sample-data augmenter. Adds projects + many tasks + a few labels
// + activity rows on top of an already-seeded database. Anchored to NOW so
// the dashboard widgets (Completion trend, Upcoming deadlines, Recent
// activity, Overdue KPI) all surface fresh-looking data.
//
// Run inside the backend container:
//   docker cp backend/prisma/sample-data.mjs taskhub-backend-1:/tmp/sample.mjs
//   docker compose exec backend node /tmp/sample.mjs
//
// Idempotent-ish: skips creating projects with names this script already
// inserted. Re-running adds another batch of tasks/comments though, so don't
// run it repeatedly unless you want N copies.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DAY = 86_400_000;
const now = new Date();
const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const offset = (days) => new Date(todayUtc.getTime() + days * DAY);

function pick(arr, i) { return arr[i % arr.length]; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  console.log(`Anchoring sample data to ${todayUtc.toISOString().slice(0, 10)}`);

  const team = await prisma.team.findFirst({ where: { slug: 'demo-team' } });
  if (!team) throw new Error('Demo Team not found — run `npx prisma db seed` first.');

  const users = await prisma.user.findMany({
    where: { memberships: { some: { teamId: team.id } } },
    select: { id: true, name: true, email: true },
  });
  if (users.length === 0) throw new Error('No users in Demo Team.');
  console.log(`Found team ${team.name} with ${users.length} members.`);

  const admin = users.find((u) => u.email.startsWith('admin')) ?? users[0];
  const others = users.filter((u) => u.id !== admin.id);

  // ── Extra labels ────────────────────────────────────────────────────────
  const labelSpec = [
    { name: 'security', color: '#dc2626' },
    { name: 'performance', color: '#f59e0b' },
    { name: 'design', color: '#ec4899' },
    { name: 'tech-debt', color: '#64748b' },
    { name: 'customer', color: '#10b981' },
  ];
  for (const l of labelSpec) {
    await prisma.label.upsert({
      where: { teamId_name: { teamId: team.id, name: l.name } },
      update: { color: l.color },
      create: { teamId: team.id, name: l.name, color: l.color },
    });
  }
  const allLabels = await prisma.label.findMany({ where: { teamId: team.id } });
  console.log(`Labels: ${allLabels.length} total.`);

  // ── Extra projects ──────────────────────────────────────────────────────
  const projectSpec = [
    { name: 'Marketing site', description: 'Public-facing Next.js site + blog.', owner: admin.id },
    { name: 'DevOps', description: 'CI/CD pipelines, observability, on-call rotation.', owner: pick(others, 0)?.id ?? admin.id },
    { name: 'Analytics', description: 'Self-hosted product analytics + event pipelines.', owner: pick(others, 1)?.id ?? admin.id },
    { name: 'Customer success', description: 'Onboarding, support tooling, NPS.', owner: pick(others, 2)?.id ?? admin.id },
  ];

  const projectsByName = new Map();
  for (const ps of projectSpec) {
    let p = await prisma.project.findFirst({ where: { teamId: team.id, name: ps.name } });
    if (!p) {
      p = await prisma.project.create({
        data: {
          teamId: team.id,
          ownerId: ps.owner,
          name: ps.name,
          description: ps.description,
        },
      });
      console.log(`  + project ${p.name}`);
    } else {
      console.log(`  · project ${p.name} (already exists)`);
    }
    projectsByName.set(ps.name, p);
  }
  // Mix in the original demo projects too so we spread tasks across all of them.
  const originalProjects = await prisma.project.findMany({
    where: { teamId: team.id, name: { in: ['Mobile App v3', 'Platform', 'Internal Tools'] } },
  });
  for (const p of originalProjects) projectsByName.set(p.name, p);
  const projects = [...projectsByName.values()];
  console.log(`Projects we will spread tasks across: ${projects.length}`);

  // ── A big batch of tasks ────────────────────────────────────────────────
  // Designed to make the dashboard look real:
  //   - Many DONE in the last 30 days (drives Completion trend bars).
  //   - A handful overdue (drives Overdue KPI).
  //   - Several due in next 7 days, several of those assigned to admin
  //     (drives Upcoming deadlines panel).
  //   - Activity rows are emitted for every task so Recent activity fills.
  const STATUSES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'];
  const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

  const TITLES = [
    'Refactor auth middleware', 'Document deploy runbook', 'Optimise N+1 query in reports',
    'Migrate to argon2id', 'Audit S3 bucket policies', 'Add CSP headers to Caddyfile',
    'Refresh-token rotation tests', 'CSV export performance fix', 'Improve onboarding email copy',
    'Dark-mode tweaks for kanban', 'Investigate flaky LDAP test', 'Add Sentry SDK to frontend',
    'Webhook retry-with-backoff', 'Implement bulk-edit for tasks', 'Localise Settings page',
    'Replace deprecated date-fns helpers', 'Persian calendar QA pass', 'Reduce Tailwind bundle size',
    'Add API rate-limit dashboard', 'Cache /reports/summary aggressively', 'Fix scrollbar gutter jitter',
    'Sketch project templates feature', 'Roll out 2FA recovery export', 'Replace inline JS in Caddyfile',
    'GDPR data-export endpoint', 'Add load test for /search', 'Cron janitor for orphan attachments',
    'Audit log retention policy', 'Switch FE to React Compiler', 'CSV import for tasks',
    'Custom statuses per project (spike)', 'Replace prisma-engine docker hack', 'Document backup-restore SLA',
    'Renovate dependabot config', 'Bun runtime experiment', 'Telemetry opt-out toggle',
    'Trash auto-purge after 30 days', 'New chart: cumulative flow', 'Bug: comment counter off-by-one',
    'Wire Sentry breadcrumbs to logs',
  ];

  const tasksToCreate = [];

  // Group A: 24 DONE tasks spread over the past 30 days — feeds the trend chart.
  for (let i = 0; i < 24; i++) {
    const daysAgo = Math.floor(Math.random() * 30);
    const completedAt = offset(-daysAgo);
    tasksToCreate.push({
      title: pick(TITLES, i) + (i >= TITLES.length ? ` (cont. ${i})` : ''),
      status: 'DONE',
      priority: pickRandom(PRIORITIES),
      assigneeId: pick(users, i).id,
      projectId: pick(projects, i).id,
      completedAt,
      // Half of them with a plannedDate too, so timeliness has data.
      plannedDate: i % 2 === 0 ? offset(-daysAgo - 1 + (i % 3)) : null,
    });
  }

  // Group B: 6 overdue tasks (open + dueDate in the past) — feeds Overdue KPI.
  for (let i = 0; i < 6; i++) {
    tasksToCreate.push({
      title: pick(TITLES, 24 + i),
      status: i % 3 === 0 ? 'IN_PROGRESS' : 'TODO',
      priority: i % 2 === 0 ? 'HIGH' : 'URGENT',
      assigneeId: pick(users, 24 + i).id,
      projectId: pick(projects, 24 + i).id,
      dueDate: offset(-(1 + Math.floor(Math.random() * 5))),
    });
  }

  // Group C: 8 upcoming tasks due in the next 7 days, mostly assigned to admin
  // so the "Upcoming deadlines" widget actually has rows for the logged-in user.
  for (let i = 0; i < 8; i++) {
    tasksToCreate.push({
      title: pick(TITLES, 30 + i),
      status: pick(['TODO', 'IN_PROGRESS', 'REVIEW'], i),
      priority: pickRandom(PRIORITIES),
      assigneeId: i % 4 === 3 ? pick(users, i).id : admin.id,
      projectId: pick(projects, 30 + i).id,
      dueDate: offset(1 + (i % 7)),
    });
  }

  // Group D: a few in-progress / review tasks with no dates — pure "open work".
  for (let i = 0; i < 6; i++) {
    tasksToCreate.push({
      title: pick(TITLES, 33 + i) + ' (WIP)',
      status: i % 2 === 0 ? 'IN_PROGRESS' : 'REVIEW',
      priority: pickRandom(PRIORITIES),
      assigneeId: pick(users, i).id,
      projectId: pick(projects, i + 1).id,
    });
  }

  console.log(`Creating ${tasksToCreate.length} tasks…`);
  const createdTasks = [];
  for (let i = 0; i < tasksToCreate.length; i++) {
    const t = tasksToCreate[i];
    const created = await prisma.task.create({
      data: {
        teamId: team.id,
        projectId: t.projectId,
        creatorId: t.assigneeId,
        technicianId: t.assigneeId,
        assigneeId: t.assigneeId,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate ?? null,
        plannedDate: t.plannedDate ?? null,
        completedAt: t.completedAt ?? null,
        position: i,
      },
    });
    createdTasks.push(created);

    // Attach 0–2 random labels per task.
    const tagCount = Math.floor(Math.random() * 3);
    const chosenLabels = [...allLabels].sort(() => Math.random() - 0.5).slice(0, tagCount);
    for (const label of chosenLabels) {
      await prisma.taskLabel.create({
        data: { taskId: created.id, labelId: label.id },
      }).catch(() => {});
    }

    // Activity row for the create — mirrors what activityLogger writes when
    // a task is created via the API. createdAt is anchored to the task's
    // completedAt (when present) or now, so the Recent activity feed shows
    // a mix of fresh + recent events.
    const createdAt = t.completedAt ?? new Date(now.getTime() - i * 60_000);
    await prisma.activity.create({
      data: {
        taskId: created.id,
        teamId: team.id,
        actorId: t.assigneeId,
        action: 'task.created',
        meta: { title: t.title },
        createdAt,
      },
    });
    // For DONE tasks, also emit a status_changed event around completedAt.
    if (t.status === 'DONE' && t.completedAt) {
      await prisma.activity.create({
        data: {
          taskId: created.id,
          teamId: team.id,
          actorId: t.assigneeId,
          action: 'task.status_changed',
          meta: { from: 'IN_PROGRESS', to: 'DONE' },
          createdAt: t.completedAt,
        },
      });
    }
  }
  console.log(`Created ${createdTasks.length} tasks + matching activity rows.`);

  // ── A few comments on random tasks ──────────────────────────────────────
  const COMMENTS = [
    'Picking this up today.',
    'Blocked on infra ticket #4321.',
    'Spec looks good — proceeding.',
    'Reviewed PR, left comments.',
    'This one needs design input.',
    'Pushed a fix; ready for QA.',
    'Reproduced locally — narrowing down.',
    'Let’s defer to next sprint.',
  ];
  let commentCount = 0;
  for (const task of createdTasks.slice(0, 18)) {
    const author = pick(users, commentCount);
    await prisma.comment.create({
      data: {
        taskId: task.id,
        authorId: author.id,
        body: pick(COMMENTS, commentCount),
      },
    });
    await prisma.activity.create({
      data: {
        taskId: task.id,
        teamId: team.id,
        actorId: author.id,
        action: 'comment.created',
        meta: { body: pick(COMMENTS, commentCount).slice(0, 40) },
        createdAt: new Date(now.getTime() - commentCount * 30_000),
      },
    });
    commentCount++;
  }
  console.log(`Created ${commentCount} comments.`);

  // ── Final summary ───────────────────────────────────────────────────────
  const counts = {
    users: await prisma.user.count(),
    teams: await prisma.team.count(),
    projects: await prisma.project.count(),
    tasks: await prisma.task.count(),
    comments: await prisma.comment.count(),
    activity: await prisma.activity.count(),
  };
  console.log('Final counts:', counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
