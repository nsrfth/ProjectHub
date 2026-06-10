import {
  PrismaClient,
  GlobalRole,
  TeamRole,
  TaskStatus,
  TaskPriority,
} from '@prisma/client';
import argon2 from 'argon2';
import { ensureSystemManagerOnTeam } from '../src/lib/systemUser.js';

const prisma = new PrismaClient();

// UTC-midnight calendar date. Pair this with formatShamsiCalendar* on the
// frontend so the displayed day matches everywhere, regardless of viewer TZ.
function day(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

// "Today" for the demo dataset. We anchor all sample dates to this so the
// Timeliness report (default 7-day window) shows a deliberate mix of on-time,
// late, early, and behind-plan tasks without depending on the real clock.
const TODAY = day(2026, 5, 22);

async function main(): Promise<void> {
  // Installer hook (install.sh / install.ps1): seed honours these env vars so
  // the first admin lands with operator-chosen credentials instead of the
  // weak default. Fall back to the legacy demo defaults when unset so
  // `prisma db seed` keeps working stand-alone.
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@taskhub.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin';
  const memberPassword = 'demo1234';

  // Idempotent: if the demo admin already exists with at least one project,
  // skip seeding so this script is safe to re-run during `prisma migrate dev`
  // without nuking hand-edited state.
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    const projectCount = await prisma.project.count();
    if (projectCount > 0) {
      console.log('Seed: admin + projects already present, skipping.');
      return;
    }
  }

  const adminHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
  const memberHash = await argon2.hash(memberPassword, { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { isSystemUser: adminEmail.toLowerCase() === 'admin@taskhub.local' },
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      name: 'Admin',
      globalRole: GlobalRole.ADMIN,
      isSystemUser: adminEmail.toLowerCase() === 'admin@taskhub.local',
      emailVerifiedAt: TODAY,
    },
  });

  const maya = await prisma.user.upsert({
    where: { email: 'maya@taskhub.local' },
    update: {},
    create: {
      email: 'maya@taskhub.local',
      passwordHash: memberHash,
      name: 'Maya Patel',
      globalRole: GlobalRole.MEMBER,
      emailVerifiedAt: TODAY,
    },
  });

  const jordan = await prisma.user.upsert({
    where: { email: 'jordan@taskhub.local' },
    update: {},
    create: {
      email: 'jordan@taskhub.local',
      passwordHash: memberHash,
      name: 'Jordan Lee',
      globalRole: GlobalRole.MEMBER,
      emailVerifiedAt: TODAY,
    },
  });

  const riley = await prisma.user.upsert({
    where: { email: 'riley@taskhub.local' },
    update: {},
    create: {
      email: 'riley@taskhub.local',
      passwordHash: memberHash,
      name: 'Riley Park',
      globalRole: GlobalRole.MEMBER,
      emailVerifiedAt: TODAY,
    },
  });

  // v1.12: seed an accent colour so the kanban + calendar render the
  // team in colour out of the box.
  const team = await prisma.team.upsert({
    where: { slug: 'demo-team' },
    update: {},
    create: { name: 'Demo Team', slug: 'demo-team', color: '#3b82f6' },
  });

  // v1.23: ensure the team has its two system roles (Manager + Member) with
  // the default permission sets. Migration creates these for upgrades; seed
  // re-runs need to create them too for fresh installs.
  const DEFAULT_MANAGER_PERMS = [
    'task.delete',
    'task.modify_dates',
    'task.change_technician',
    'task.change_assignee',
    'comment.delete_others',
    'project.edit',
    'project.delete',
    'project.set_accountable',
    'team.invite_member',
    'team.remove_member',
    'team.change_role',
    'team.manage_roles',
    'webhooks.manage',
    'trash.purge',
  ];
  const DEFAULT_MEMBER_PERMS = ['task.delete', 'task.modify_dates'];

  async function ensureSystemRole(name: 'Manager' | 'Member', perms: string[]): Promise<string> {
    const existing = await prisma.role.findUnique({
      where: { teamId_name: { teamId: team.id, name } },
    });
    if (existing) return existing.id;
    const created = await prisma.role.create({
      data: {
        teamId: team.id,
        name,
        description: `Default ${name} role. System-managed: editable but undeletable.`,
        isSystem: true,
        permissions: { create: perms.map((permission) => ({ permission })) },
      },
    });
    return created.id;
  }
  const managerRoleId = await ensureSystemRole('Manager', DEFAULT_MANAGER_PERMS);
  const memberRoleId = await ensureSystemRole('Member', DEFAULT_MEMBER_PERMS);

  // Memberships — admin + riley as MANAGERs so the demo exercises both roles.
  for (const [user, role] of [
    [admin, TeamRole.MANAGER],
    [riley, TeamRole.MANAGER],
    [maya, TeamRole.MEMBER],
    [jordan, TeamRole.MEMBER],
  ] as const) {
    const roleId = role === TeamRole.MANAGER ? managerRoleId : memberRoleId;
    await prisma.teamMembership.upsert({
      where: { userId_teamId: { userId: user.id, teamId: team.id } },
      update: { role, roleId },
      create: { userId: user.id, teamId: team.id, role, roleId },
    });
  }

  await ensureSystemManagerOnTeam(team.id);

  const labels = await Promise.all(
    [
      { name: 'bug', color: '#dc2626' },
      { name: 'feature', color: '#2563eb' },
      { name: 'docs', color: '#16a34a' },
      { name: 'infra', color: '#7c3aed' },
    ].map((l) =>
      prisma.label.upsert({
        where: { teamId_name: { teamId: team.id, name: l.name } },
        update: { color: l.color },
        create: { teamId: team.id, name: l.name, color: l.color },
      }),
    ),
  );
  const labelByName = new Map(labels.map((l): [string, typeof l] => [l.name, l]));

  const mobile = await prisma.project.create({
    data: {
      teamId: team.id,
      ownerId: admin.id,
      name: 'Mobile App v3',
      description: 'React Native rewrite of the consumer app.',
    },
  });
  const platform = await prisma.project.create({
    data: {
      teamId: team.id,
      ownerId: riley.id,
      name: 'Platform',
      description: 'Backend services, infra, and developer experience.',
    },
  });
  const internal = await prisma.project.create({
    data: {
      teamId: team.id,
      ownerId: maya.id,
      name: 'Internal Tools',
      description: 'Admin UIs, scripts, and one-off integrations.',
    },
  });

  // Dataset designed to hit specific Timeliness numbers.
  // Within 7-day window (since 2026-05-15), 4 completed tasks:
  //   variance −2, +1, 0, +3   →  on-time rate 2/4 = 50%, avg +0.5d.
  // Within 30-day window: +2 more (variance +4 and −1) →
  //   on-time rate 3/6 = 50%, avg +5/6 ≈ 0.83d.
  // Open + planned-in-past: 3 tasks  →  behindPlanCount = 3.
  type Seed = {
    project: string;
    assignee: string | null;
    title: string;
    description?: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate?: Date;
    plannedDate?: Date;
    completedAt?: Date;
    labels?: string[];
  };
  const PROJECTS: Record<string, string> = {
    mobile: mobile.id,
    platform: platform.id,
    internal: internal.id,
  };
  const USERS: Record<string, string> = {
    admin: admin.id,
    maya: maya.id,
    jordan: jordan.id,
    riley: riley.id,
  };

  const tasks: Seed[] = [
    // ── Completed within 7-day window ─────────────────────────────────────
    {
      project: 'mobile',
      assignee: 'jordan',
      title: 'Fix login screen layout on small devices',
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      plannedDate: day(2026, 5, 22),
      completedAt: day(2026, 5, 20), // 2 days early → on-time
      labels: ['bug'],
    },
    {
      project: 'mobile',
      assignee: 'riley',
      title: 'Settings page wireframes',
      status: TaskStatus.DONE,
      priority: TaskPriority.MEDIUM,
      plannedDate: day(2026, 5, 20),
      completedAt: day(2026, 5, 21), // 1 day late
      labels: ['feature'],
    },
    {
      project: 'platform',
      assignee: 'admin',
      title: 'Database connection pooling',
      description: 'Switch to pgbouncer; cap pool size per worker.',
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      plannedDate: day(2026, 5, 17),
      completedAt: day(2026, 5, 17), // on-time exact
      labels: ['infra'],
    },
    {
      project: 'platform',
      assignee: 'maya',
      title: 'Document new endpoints',
      status: TaskStatus.DONE,
      priority: TaskPriority.LOW,
      plannedDate: day(2026, 5, 16),
      completedAt: day(2026, 5, 19), // 3 days late
      labels: ['docs'],
    },

    // ── Completed earlier (in 30d but outside 7d) ─────────────────────────
    {
      project: 'mobile',
      assignee: 'maya',
      title: 'Migrate to React Native 0.75',
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      plannedDate: day(2026, 5, 8),
      completedAt: day(2026, 5, 12), // 4 days late
      labels: ['infra'],
    },
    {
      project: 'internal',
      assignee: 'jordan',
      title: 'Q1 onboarding revamp',
      status: TaskStatus.DONE,
      priority: TaskPriority.MEDIUM,
      plannedDate: day(2026, 5, 5),
      completedAt: day(2026, 5, 4), // 1 day early
      labels: ['feature'],
    },

    // ── Open, behind plan (planned in the past) ───────────────────────────
    {
      project: 'mobile',
      assignee: 'jordan',
      title: 'Crash on cold start (iOS 17)',
      description: 'Stack trace points at the splash-screen layout pass.',
      status: TaskStatus.TODO,
      priority: TaskPriority.URGENT,
      dueDate: day(2026, 5, 21), // overdue
      plannedDate: day(2026, 5, 18), // behind plan
      labels: ['bug'],
    },
    {
      project: 'platform',
      assignee: 'maya',
      title: 'Login broken in Safari 17',
      status: TaskStatus.REVIEW,
      priority: TaskPriority.HIGH,
      plannedDate: day(2026, 5, 20), // behind plan
      labels: ['bug'],
    },
    {
      project: 'internal',
      assignee: 'jordan',
      title: 'Memory leak in image processor',
      status: TaskStatus.TODO,
      priority: TaskPriority.HIGH,
      dueDate: day(2026, 5, 19), // overdue
      plannedDate: day(2026, 5, 19), // behind plan
      labels: ['bug', 'infra'],
    },

    // ── Open, on track (planned in the future) ────────────────────────────
    {
      project: 'mobile',
      assignee: 'maya',
      title: 'Add push notifications',
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.MEDIUM,
      dueDate: day(2026, 5, 25),
      plannedDate: day(2026, 5, 24),
      labels: ['feature'],
    },
    {
      project: 'mobile',
      assignee: 'jordan',
      title: 'Update onboarding flow',
      status: TaskStatus.REVIEW,
      priority: TaskPriority.MEDIUM,
      plannedDate: day(2026, 5, 26),
      labels: ['feature'],
    },
    {
      project: 'platform',
      assignee: 'jordan',
      title: 'Build user management page',
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.MEDIUM,
      dueDate: day(2026, 5, 27),
      plannedDate: day(2026, 5, 25),
      labels: ['feature'],
    },
    {
      project: 'platform',
      assignee: 'admin',
      title: 'Rate limit metrics',
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.LOW,
      dueDate: day(2026, 5, 29),
      plannedDate: day(2026, 5, 30),
      labels: ['infra'],
    },
    {
      project: 'mobile',
      assignee: 'riley',
      title: 'Implement dark mode',
      status: TaskStatus.TODO,
      priority: TaskPriority.LOW,
      dueDate: day(2026, 6, 5),
      plannedDate: day(2026, 6, 2),
      labels: ['feature'],
    },
    {
      project: 'internal',
      assignee: 'admin',
      title: 'Webhook delivery queue',
      status: TaskStatus.TODO,
      priority: TaskPriority.MEDIUM,
      dueDate: day(2026, 6, 12),
      plannedDate: day(2026, 6, 8),
      labels: ['feature', 'infra'],
    },

    // ── Open, no planned date (intentional — exercises the "null" path) ───
    {
      project: 'platform',
      assignee: 'riley',
      title: 'Add audit log viewer',
      status: TaskStatus.TODO,
      priority: TaskPriority.LOW,
      dueDate: day(2026, 6, 21),
      labels: ['feature'],
    },
    {
      project: 'platform',
      assignee: 'maya',
      title: 'Reports page CSV export',
      status: TaskStatus.TODO,
      priority: TaskPriority.MEDIUM,
      dueDate: day(2026, 5, 31),
      labels: ['feature'],
    },
    {
      project: 'internal',
      assignee: null,
      title: 'Consider switching to gRPC for internal calls',
      status: TaskStatus.TODO,
      priority: TaskPriority.LOW,
    },
  ];

  let position = 0;
  for (const t of tasks) {
    const created = await prisma.task.create({
      data: {
        projectId: PROJECTS[t.project]!,
        teamId: team.id,
        creatorId: admin.id,
        assigneeId: t.assignee ? USERS[t.assignee] : null,
        // v1.19: technician defaults to creator (matches tasksService.create).
        // The seed bypasses the service, so set it explicitly here.
        technicianId: admin.id,
        title: t.title,
        description: t.description ?? null,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate ?? null,
        plannedDate: t.plannedDate ?? null,
        completedAt: t.completedAt ?? null,
        position: position++,
      },
    });
    if (t.labels?.length) {
      await prisma.taskLabel.createMany({
        data: t.labels
          .map((n) => labelByName.get(n))
          .filter((l): l is NonNullable<typeof l> => !!l)
          .map((l) => ({ taskId: created.id, labelId: l.id })),
      });
    }
  }

  console.log('Seed complete.');
  console.log(`  admin:    ${adminEmail} / ${adminPassword}`);
  console.log(`  members:  maya/jordan/riley @taskhub.local / ${memberPassword}`);
  console.log(`  team:     ${team.slug}`);
  console.log(`  tasks:    ${tasks.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
