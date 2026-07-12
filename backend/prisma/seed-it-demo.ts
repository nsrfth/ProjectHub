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

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(base: Date, n: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n));
}

const TODAY = utcDay(new Date());
const DEMO_PASSWORD = 'Demo2026!';

const LABEL_DEFS = [
  { name: 'incident', color: '#dc2626' },
  { name: 'change', color: '#f59e0b' },
  { name: 'project', color: '#2563eb' },
  { name: 'maintenance', color: '#64748b' },
  { name: 'compliance', color: '#7c3aed' },
  { name: 'documentation', color: '#16a34a' },
] as const;

const TEAM_DEFS = [
  { slug: 'network', name: 'Network', color: '#2563eb' },
  { slug: 'security', name: 'Security', color: '#dc2626' },
  { slug: 'datacenter', name: 'Datacenter', color: '#7c3aed' },
  { slug: 'service-desk', name: 'Service Desk', color: '#16a34a' },
] as const;

const USER_DEFS = [
  { email: 'nina.brooks@itdemo.local', name: 'Nina Brooks', team: 'network', lead: true },
  { email: 'ethan.cole@itdemo.local', name: 'Ethan Cole', team: 'network', lead: false },
  { email: 'mia.turner@itdemo.local', name: 'Mia Turner', team: 'network', lead: false },
  { email: 'liam.nguyen@itdemo.local', name: 'Liam Nguyen', team: 'network', lead: false },
  { email: 'omar.hassan@itdemo.local', name: 'Omar Hassan', team: 'security', lead: true },
  { email: 'sara.kim@itdemo.local', name: 'Sara Kim', team: 'security', lead: false },
  { email: 'james.wright@itdemo.local', name: 'James Wright', team: 'security', lead: false },
  { email: 'priya.shah@itdemo.local', name: 'Priya Shah', team: 'datacenter', lead: true },
  { email: 'dan.roberts@itdemo.local', name: 'Dan Roberts', team: 'datacenter', lead: false },
  { email: 'emma.liu@itdemo.local', name: 'Emma Liu', team: 'datacenter', lead: false },
  { email: 'chris.taylor@itdemo.local', name: 'Chris Taylor', team: 'service-desk', lead: true },
  { email: 'alex.rivera@itdemo.local', name: 'Alex Rivera', team: 'service-desk', lead: false },
  { email: 'jordan.miles@itdemo.local', name: 'Jordan Miles', team: 'service-desk', lead: false },
] as const;

const PROJECT_DEFS: Array<{ team: string; name: string; description: string; ownerEmail: string }> = [
  { team: 'network', name: 'Core Switch Refresh 2026', description: 'Replace aging core switches in HQ and DC1.', ownerEmail: 'nina.brooks@itdemo.local' },
  { team: 'network', name: 'Branch Wi-Fi Upgrade', description: 'Wi-Fi 6E rollout to 24 branch sites.', ownerEmail: 'ethan.cole@itdemo.local' },
  { team: 'network', name: 'SD-WAN Rollout Phase 2', description: 'Extend SD-WAN to remaining regional offices.', ownerEmail: 'mia.turner@itdemo.local' },
  { team: 'security', name: 'ISO 27001 Gap Remediation', description: 'Close audit findings before Q4 certification.', ownerEmail: 'omar.hassan@itdemo.local' },
  { team: 'security', name: 'EDR Deployment', description: 'Enterprise EDR agent rollout to all endpoints.', ownerEmail: 'sara.kim@itdemo.local' },
  { team: 'security', name: 'PAM & Secrets Vault', description: 'Privileged access management and vault integration.', ownerEmail: 'james.wright@itdemo.local' },
  { team: 'datacenter', name: 'VMware Migration Wave 1', description: 'Migrate 120 VMs from VMware to Hyper-V.', ownerEmail: 'priya.shah@itdemo.local' },
  { team: 'datacenter', name: 'Backup Platform Modernization', description: 'Replace legacy backup with immutable storage.', ownerEmail: 'dan.roberts@itdemo.local' },
  { team: 'datacenter', name: 'DR Failover Test Q3', description: 'Quarterly disaster-recovery exercise and runbook update.', ownerEmail: 'emma.liu@itdemo.local' },
  { team: 'service-desk', name: 'ITSM Tool Rollout', description: 'ServiceNow module configuration and cutover.', ownerEmail: 'chris.taylor@itdemo.local' },
  { team: 'service-desk', name: 'New Hire Onboarding Automation', description: 'Automate account provisioning and laptop imaging.', ownerEmail: 'alex.rivera@itdemo.local' },
  { team: 'service-desk', name: 'Tier-1 Knowledge Base Refresh', description: 'Rewrite top 50 KB articles and deflection flows.', ownerEmail: 'jordan.miles@itdemo.local' },
];

const TASK_TITLES: Record<string, string[]> = {
  'Core Switch Refresh 2026': [
    'Inventory core switch fleet', 'Procure replacement chassis', 'Staging VLAN cutover plan',
    'BGP peering validation with ISP-B', 'Replace failed SFP module Row 3', 'Document NetBox IPAM schema',
    'After-hours maintenance window booking', 'Rollback procedure review', 'Post-cutover smoke tests',
    'Update network topology diagrams', 'Train NOC on new monitoring', 'Validate STP root bridge election',
    'Core switch firmware baseline', 'Capacity review for 2027', 'Handoff to operations runbook',
  ],
  'Branch Wi-Fi Upgrade': [
    'Site survey Branch 12', 'AP mounting standards update', 'Controller cluster patch',
    'Guest SSID captive portal fix', 'RF heatmap validation', 'Replace PoE switches Floor 2',
    'Certificate renewal for RADIUS', 'Roaming test iOS/Android', 'Document branch Wi-Fi playbook',
    'Resolve DHCP exhaustion Site 7', 'Upgrade WLC firmware', 'Survey feedback triage',
    'Vendor RMA tracking', 'Pilot site go-live', 'KB: connect to corporate Wi-Fi',
  ],
  'SD-WAN Rollout Phase 2': [
    'Edge device shipping schedule', 'Template policy review', 'Application SLA mapping',
    'MPLS circuit decommission plan', 'QoS policy for VoIP', 'Hub failover test',
    'Dashboard alert tuning', 'Branch #18 cutover', 'Latency baseline report',
    'Security policy sync', 'Zero-touch provisioning test', 'Escalation matrix update',
    'Performance regression triage', 'Operations training session', 'Closeout documentation',
  ],
  'ISO 27001 Gap Remediation': [
    'Access review Finance app', 'Policy document v3 draft', 'Risk register update',
    'Vendor SOC2 evidence collection', 'Incident response tabletop', 'Encryption at rest audit',
    'Logging retention alignment', 'Segregation of duties matrix', 'Awareness training rollout',
    'Pen test finding #4 remediation', 'Backup restore evidence pack', 'Change management sample audit',
    'Asset inventory reconciliation', 'Internal audit prep', 'Management review slides',
  ],
  'EDR Deployment': [
    'Agent packaging for macOS', 'Exclusion list for dev tools', 'Pilot group deployment',
    'Alert fatigue tuning', 'Tamper protection validation', 'Linux server agent rollout',
    'SOC playbook integration', 'False positive review queue', 'Uninstall legacy AV',
    'Executive dashboard KPIs', 'Threat hunt workshop', 'Offline installer distribution',
    'Compliance reporting export', 'Critical server phased rollout', 'Deployment sign-off',
  ],
  'PAM & Secrets Vault': [
    'Vault HA cluster sizing', 'Break-glass account procedure', 'Service account rotation',
    'SSH key onboarding workflow', 'Database credential checkout', 'Session recording review',
    'Integration with Active Directory', 'Just-in-time access pilot', 'Secrets sprawl discovery scan',
    'API token lifecycle policy', 'Vendor vault connector test', 'Audit trail export',
    'Emergency access drill', 'Privileged session monitoring', 'Operations handover',
  ],
  'VMware Migration Wave 1': [
    'VM dependency mapping', 'Storage performance baseline', 'Migration batch 1 schedule',
    'Hyper-V host patching', 'VLAN stretch validation', 'Guest agent compatibility check',
    'Rollback snapshot policy', 'Post-migration CPU alignment', 'Licensing reconciliation',
    'Application owner sign-off batch 2', 'Network latency post-move', 'Backup job reconfiguration',
    'Monitoring agent reinstall', 'Capacity forecast update', 'Wave 1 retrospective',
  ],
  'Backup Platform Modernization': [
    'Immutable bucket provisioning', 'Legacy backup job inventory', 'Restore test VM weekly',
    'RPO/RTO matrix approval', 'Tape library decommission', 'Cloud tier lifecycle policy',
    'Backup network isolation', 'Encryption key rotation', 'Alert on failed job SLA',
    'Application-aware backup pilot', 'DR copy replication lag fix', 'Restore runbook v2',
    'Vendor support case #9921', 'Cost optimization review', 'Platform go-live checklist',
  ],
  'DR Failover Test Q3': [
    'DR site network validation', 'Failover communication plan', 'Database log shipping check',
    'Application startup order doc', 'DNS cutover procedure', 'Stakeholder notification template',
    'Failback rehearsal', 'RTO measurement capture', 'Storage sync verification',
    'Third-party dependency list', 'Lessons learned workshop', 'Runbook gap remediation',
    'Executive summary report', 'Next test schedule', 'Sign-off from app owners',
  ],
  'ITSM Tool Rollout': [
    'Catalog item design workshop', 'SLA definition for P1/P2', 'Email-to-ticket routing',
    'CMDB discovery agent pilot', 'Change advisory board workflow', 'Self-service portal branding',
    'Integration with monitoring alerts', 'Knowledge deflection analytics', 'Agent training modules',
    'Data migration dry run', 'Cutover weekend war room plan', 'Hypercare support roster',
    'Reporting dashboard for leadership', 'Retire legacy ticket queues', 'Post-go-live survey',
  ],
  'New Hire Onboarding Automation': [
    'HRIS integration mapping', 'AD group template review', 'Laptop imaging standard update',
    'MFA enrollment step automation', 'Welcome email template', 'Software bundle by role',
    'Manager approval workflow', 'Access provisioning audit log', 'Offboarding mirror workflow',
    'Exception handling for contractors', 'Service desk training deck', 'Pilot with HR cohort',
    'Provisioning SLA dashboard', 'Fix duplicate account bug', 'Automation runbook publish',
  ],
  'Tier-1 Knowledge Base Refresh': [
    'Top 50 article traffic analysis', 'VPN troubleshooting rewrite', 'Password reset guide update',
    'Printer setup macOS/Windows', 'Outlook cache rebuild steps', 'Teams audio issue playbook',
    'Escalation criteria refresh', 'Screenshot standard template', 'Search keyword optimization',
    'Deflection rate baseline', 'Peer review queue', 'Retire outdated articles batch 1',
    'Chatbot intent mapping', 'CSAT feedback themes', 'Publish refresh changelog',
  ],
};

const TASK_PROFILES: Array<{
  status: TaskStatus;
  priority: TaskPriority;
  dueOffset: number | null;
  plannedOffset: number | null;
  completedOffset: number | null;
  label: (typeof LABEL_DEFS)[number]['name'];
}> = [
  { status: 'DONE', priority: 'HIGH', dueOffset: -10, plannedOffset: -12, completedOffset: -12, label: 'project' },
  { status: 'DONE', priority: 'MEDIUM', dueOffset: -8, plannedOffset: -9, completedOffset: -8, label: 'change' },
  { status: 'DONE', priority: 'LOW', dueOffset: -5, plannedOffset: -6, completedOffset: -7, label: 'documentation' },
  { status: 'DONE', priority: 'HIGH', dueOffset: -14, plannedOffset: -15, completedOffset: -11, label: 'incident' },
  { status: 'DONE', priority: 'MEDIUM', dueOffset: -20, plannedOffset: -22, completedOffset: -18, label: 'maintenance' },
  { status: 'DONE', priority: 'HIGH', dueOffset: -25, plannedOffset: -26, completedOffset: -24, label: 'compliance' },
  { status: 'TODO', priority: 'URGENT', dueOffset: -3, plannedOffset: -5, completedOffset: null, label: 'incident' },
  { status: 'IN_PROGRESS', priority: 'HIGH', dueOffset: -1, plannedOffset: -2, completedOffset: null, label: 'incident' },
  { status: 'REVIEW', priority: 'HIGH', dueOffset: 2, plannedOffset: -1, completedOffset: null, label: 'change' },
  { status: 'TODO', priority: 'MEDIUM', dueOffset: 1, plannedOffset: 0, completedOffset: null, label: 'project' },
  { status: 'IN_PROGRESS', priority: 'MEDIUM', dueOffset: 3, plannedOffset: 2, completedOffset: null, label: 'project' },
  { status: 'TODO', priority: 'HIGH', dueOffset: 5, plannedOffset: 4, completedOffset: null, label: 'change' },
  { status: 'TODO', priority: 'LOW', dueOffset: 10, plannedOffset: 9, completedOffset: null, label: 'documentation' },
  { status: 'IN_PROGRESS', priority: 'MEDIUM', dueOffset: 14, plannedOffset: 12, completedOffset: null, label: 'maintenance' },
  { status: 'TODO', priority: 'LOW', dueOffset: null, plannedOffset: null, completedOffset: null, label: 'project' },
];

const DEFAULT_MANAGER_PERMS = [
  'task.delete', 'task.modify_dates', 'task.change_responsible', 'task.change_assignee',
  'comment.delete_others', 'project.edit', 'project.delete', 'project.set_accountable',
  'team.invite_member', 'team.remove_member', 'team.change_role', 'team.manage_roles',
  'webhooks.manage', 'trash.purge',
];
const DEFAULT_MEMBER_PERMS = ['task.delete', 'task.modify_dates'];
// v2.5.54: PMO oversight role default permissions (see src/lib/permissions.ts).
const DEFAULT_PMO_PERMS = [
  'project.read_all', 'portfolio.view', 'portfolio.attach_project',
  'pmo.manage_profiles', 'pmo.assign_profile', 'pmo.override_profile',
  'pmo.set_team_defaults', 'pmo.set_group_defaults', 'core.capture_baseline',
  'change.approve', 'timesheet.approve',
];

async function ensureSystemRole(teamId: string, name: 'Manager' | 'Member' | 'PMO', perms: string[]): Promise<string> {
  const existing = await prisma.role.findUnique({
    where: { teamId_name: { teamId, name } },
  });
  if (existing) return existing.id;
  const created = await prisma.role.create({
    data: {
      teamId,
      name,
      description: `Default ${name} role.`,
      isSystem: true,
      permissions: { create: perms.map((permission) => ({ permission })) },
    },
  });
  return created.id;
}

async function main(): Promise<void> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@taskhub.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    const hash = await argon2.hash(adminPassword || 'admin', { type: argon2.argon2id });
    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: hash,
        name: 'Admin',
        globalRole: GlobalRole.ADMIN,
        isSystemUser: adminEmail.toLowerCase() === 'admin@taskhub.local',
        emailVerifiedAt: TODAY,
      },
    });
    console.log(`Created admin ${adminEmail}`);
  } else {
    admin = await prisma.user.update({
      where: { id: admin.id },
      data: {
        globalRole: GlobalRole.ADMIN,
        isSystemUser: adminEmail.toLowerCase() === 'admin@taskhub.local',
        emailVerifiedAt: admin.emailVerifiedAt ?? TODAY,
      },
    });
    console.log(`Using existing admin ${adminEmail} (password unchanged)`);
  }

  const demoHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });
  const userByEmail = new Map<string, { id: string; team: string }>();

  for (const u of USER_DEFS) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name },
      create: {
        email: u.email,
        passwordHash: demoHash,
        name: u.name,
        globalRole: GlobalRole.MEMBER,
        emailVerifiedAt: TODAY,
      },
    });
    userByEmail.set(u.email, { id: row.id, team: u.team });
  }

  const teamBySlug = new Map<string, { id: string; slug: string }>();
  for (const t of TEAM_DEFS) {
    const row = await prisma.team.upsert({
      where: { slug: t.slug },
      update: { name: t.name, color: t.color },
      create: { name: t.name, slug: t.slug, color: t.color },
    });
    teamBySlug.set(t.slug, { id: row.id, slug: t.slug });

    const managerRoleId = await ensureSystemRole(row.id, 'Manager', DEFAULT_MANAGER_PERMS);
    const memberRoleId = await ensureSystemRole(row.id, 'Member', DEFAULT_MEMBER_PERMS);
    await ensureSystemRole(row.id, 'PMO', DEFAULT_PMO_PERMS);

    for (const u of USER_DEFS.filter((x) => x.team === t.slug)) {
      const userId = userByEmail.get(u.email)!.id;
      const role = u.lead ? TeamRole.MANAGER : TeamRole.MEMBER;
      const roleId = u.lead ? managerRoleId : memberRoleId;
      await prisma.teamMembership.upsert({
        where: { userId_teamId: { userId, teamId: row.id } },
        update: { role, roleId },
        create: { userId, teamId: row.id, role, roleId },
      });
    }

    await prisma.teamMembership.upsert({
      where: { userId_teamId: { userId: admin.id, teamId: row.id } },
      update: { role: TeamRole.MANAGER, roleId: managerRoleId },
      create: { userId: admin.id, teamId: row.id, role: TeamRole.MANAGER, roleId: managerRoleId },
    });

    await ensureSystemManagerOnTeam(row.id);

    for (const l of LABEL_DEFS) {
      await prisma.label.upsert({
        where: { teamId_name: { teamId: row.id, name: l.name } },
        update: { color: l.color },
        create: { teamId: row.id, name: l.name, color: l.color },
      });
    }
  }

  const labelIdsByTeam = new Map<string, Map<string, string>>();
  for (const t of TEAM_DEFS) {
    const teamId = teamBySlug.get(t.slug)!.id;
    const labels = await prisma.label.findMany({ where: { teamId } });
    labelIdsByTeam.set(t.slug, new Map(labels.map((l) => [l.name, l.id])));
  }

  let taskCount = 0;
  let position = 0;
  let projectIndex = 0;

  for (const p of PROJECT_DEFS) {
    const teamId = teamBySlug.get(p.team)!.id;
    const ownerId = userByEmail.get(p.ownerEmail)!.id;
    const teamMembers = USER_DEFS.filter((u) => u.team === p.team).map((u) => userByEmail.get(u.email)!.id);

    let project = await prisma.project.findFirst({
      where: { teamId, name: p.name },
    });
    if (!project) {
      project = await prisma.project.create({
        data: {
          teamId,
          ownerId,
          name: p.name,
          description: p.description,
        },
      });
    }

    const titles = TASK_TITLES[p.name] ?? [];
    for (let i = 0; i < TASK_PROFILES.length; i++) {
      const profile = TASK_PROFILES[i]!;
      const title = titles[i] ?? `${p.name} — task ${i + 1}`;
      const assigneeId = teamMembers[i % teamMembers.length]!;
      const dueDate = profile.dueOffset !== null ? addDays(TODAY, profile.dueOffset) : null;
      const plannedDate = profile.plannedOffset !== null ? addDays(TODAY, profile.plannedOffset) : null;
      const completedAt =
        profile.status === TaskStatus.DONE && profile.completedOffset !== null
          ? addDays(TODAY, profile.completedOffset)
          : null;

      const existing = await prisma.task.findFirst({
        where: { projectId: project.id, title },
      });
      if (existing) continue;

      const created = await prisma.task.create({
        data: {
          projectId: project.id,
          teamId,
          creatorId: admin.id,
          assigneeId,
          responsibleId: ownerId,
          title,
          status: profile.status,
          priority: profile.priority,
          dueDate,
          plannedDate,
          completedAt,
          position: position++,
        },
      });

      const labelId = labelIdsByTeam.get(p.team)?.get(profile.label);
      if (labelId) {
        await prisma.taskLabel.create({
          data: { taskId: created.id, labelId },
        });
      }
      taskCount++;
    }

    projectIndex++;
    if (projectIndex % 3 === 0) {
      await prisma.task.create({
        data: {
          projectId: project.id,
          teamId,
          creatorId: admin.id,
          assigneeId: admin.id,
          responsibleId: ownerId,
          title: `Executive review: ${p.name}`,
          status: TaskStatus.IN_PROGRESS,
          priority: TaskPriority.MEDIUM,
          dueDate: addDays(TODAY, 4),
          plannedDate: addDays(TODAY, 3),
          position: position++,
        },
      });
      taskCount++;
    }
  }

  console.log('IT demo seed complete.');
  console.log(`  anchor date: ${TODAY.toISOString().slice(0, 10)} (UTC)`);
  console.log(`  admin:       ${adminEmail}`);
  console.log(`  demo users:  *@itdemo.local / ${DEMO_PASSWORD}`);
  console.log(`  teams:       ${TEAM_DEFS.map((t) => t.slug).join(', ')}`);
  console.log(`  projects:    ${PROJECT_DEFS.length}`);
  console.log(`  tasks:       ${taskCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
