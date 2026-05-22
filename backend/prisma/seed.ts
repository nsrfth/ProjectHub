import { PrismaClient, GlobalRole, TeamRole, TaskStatus, TaskPriority } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = 'admin@example.com';
  const adminPassword = 'ChangeMe123!';

  const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      name: 'Admin',
      globalRole: GlobalRole.ADMIN,
      emailVerifiedAt: new Date(),
    },
  });

  const team = await prisma.team.upsert({
    where: { slug: 'demo-team' },
    update: {},
    create: {
      name: 'Demo Team',
      slug: 'demo-team',
      memberships: {
        create: { userId: admin.id, role: TeamRole.MANAGER },
      },
    },
  });

  const project = await prisma.project.create({
    data: {
      teamId: team.id,
      ownerId: admin.id,
      name: 'Sample Project',
      description: 'A starter project seeded for local development.',
    },
  });

  await prisma.task.createMany({
    data: [
      {
        projectId: project.id,
        teamId: team.id,
        creatorId: admin.id,
        assigneeId: admin.id,
        title: 'Welcome to TaskHub',
        description: 'This is a seeded sample task.',
        status: TaskStatus.TODO,
        priority: TaskPriority.MEDIUM,
        position: 0,
      },
      {
        projectId: project.id,
        teamId: team.id,
        creatorId: admin.id,
        title: 'Try moving me to In Progress',
        status: TaskStatus.TODO,
        priority: TaskPriority.LOW,
        position: 1,
      },
    ],
  });

  console.log(`Seed complete.`);
  console.log(`First admin: ${adminEmail} / ${adminPassword}`);
  console.log(`Change this password immediately after first login.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
