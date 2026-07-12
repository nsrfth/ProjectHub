/**
 * EPC demo dataset — a single richly-populated Engineering / Procurement /
 * Construction project that exercises (nearly) every ProjectHub / PMIS feature:
 * WBS tree + dependencies + milestones, RACI, subtasks, custom fields, labels,
 * comments, correspondence (دبیرخانه) + contacts, cost control (CBS / budget /
 * commitments / actuals / expenses), timesheets + rate cards, resources +
 * assignments, EVM snapshots, baseline, risk / change / procurement / quality
 * registers, PMIS records, intake form, automation rule, webhook, dashboard.
 *
 * Idempotent: keyed on the flagship project code SP14-GSU. Re-running is a no-op
 * once the project exists. Run with:
 *   docker compose exec -T backend node_modules/.bin/tsx prisma/seed-epc-demo.ts
 */
import { PrismaClient, GlobalRole, TeamRole, TaskStatus, TaskPriority } from '@prisma/client';
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
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

const TEAM = { slug: 'epc-southpars', name: 'EPC — South Pars', color: '#0f766e' };

const USERS = [
  { email: 'farhad.ahmadi@epc.local', name: 'Farhad Ahmadi', role: 'Project Manager', lead: true },
  { email: 'shirin.karimi@epc.local', name: 'Shirin Karimi', role: 'Engineering Lead', lead: true },
  { email: 'reza.tehrani@epc.local', name: 'Reza Tehrani', role: 'Procurement Lead', lead: true },
  { email: 'maryam.hosseini@epc.local', name: 'Maryam Hosseini', role: 'Construction Manager', lead: true },
  { email: 'kaveh.rostami@epc.local', name: 'Kaveh Rostami', role: 'QA/QC Manager', lead: false },
  { email: 'nasrin.jafari@epc.local', name: 'Nasrin Jafari', role: 'HSE Lead', lead: false },
  { email: 'bijan.moradi@epc.local', name: 'Bijan Moradi', role: 'Planning & Cost Control', lead: false },
  { email: 'laleh.sadeghi@epc.local', name: 'Laleh Sadeghi', role: 'Document Control', lead: false },
] as const;

const LABELS = [
  { name: 'Engineering', color: '#2563eb' },
  { name: 'Procurement', color: '#f59e0b' },
  { name: 'Construction', color: '#ea580c' },
  { name: 'Commissioning', color: '#16a34a' },
  { name: 'HSE', color: '#dc2626' },
  { name: 'Quality', color: '#7c3aed' },
  { name: 'Milestone', color: '#a16207' },
] as const;

const DEFAULT_MANAGER_PERMS = [
  'task.delete', 'task.modify_dates', 'task.change_responsible', 'task.change_assignee',
  'comment.delete_others', 'project.edit', 'project.delete', 'project.set_accountable',
  'team.invite_member', 'team.remove_member', 'team.change_role', 'team.manage_roles',
  'webhooks.manage', 'trash.purge', 'core.capture_baseline',
];
const DEFAULT_MEMBER_PERMS = ['task.delete', 'task.modify_dates'];
// v2.5.54: PMO oversight role default permissions (see src/lib/permissions.ts).
const DEFAULT_PMO_PERMS = [
  'project.read_all', 'portfolio.view', 'portfolio.attach_project',
  'pmo.manage_profiles', 'pmo.assign_profile', 'pmo.override_profile',
  'pmo.set_team_defaults', 'pmo.set_group_defaults', 'core.capture_baseline',
  'change.approve', 'timesheet.approve',
];

const ALL_MODULES = [
  'cost_control', 'timesheets', 'baselines', 'cpm_schedule', 'resource_mgmt', 'evm',
  'risk', 'issue', 'change_control', 'rfi', 'document_register', 'procurement',
  'quality', 'stakeholder', 'mom',
];

async function ensureSystemRole(teamId: string, name: 'Manager' | 'Member' | 'PMO', perms: string[]): Promise<string> {
  const existing = await prisma.role.findUnique({ where: { teamId_name: { teamId, name } } });
  if (existing) return existing.id;
  const created = await prisma.role.create({
    data: {
      teamId, name, description: `Default ${name} role.`, isSystem: true,
      permissions: { create: perms.map((permission) => ({ permission })) },
    },
  });
  return created.id;
}

// One WBS leaf/summary definition.
interface TaskDef {
  key: string;
  phase: 'Engineering' | 'Procurement' | 'Construction' | 'Commissioning';
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  pct: number;
  startOff: number;
  endOff: number;
  respEmail: string;
  discipline: string;
  wbs: string;
  milestone?: boolean;
  dependsOnKey?: string;
}

const PM = 'farhad.ahmadi@epc.local';
const ENG = 'shirin.karimi@epc.local';
const PROC = 'reza.tehrani@epc.local';
const CON = 'maryam.hosseini@epc.local';
const QA = 'kaveh.rostami@epc.local';

const TASKS: TaskDef[] = [
  // Engineering
  { key: 'e1', phase: 'Engineering', title: 'Process design basis & PFDs', status: 'DONE', priority: 'HIGH', pct: 100, startOff: -120, endOff: -95, respEmail: ENG, discipline: 'Process', wbs: '1.1' },
  { key: 'e2', phase: 'Engineering', title: 'HAZOP study & closeout', status: 'DONE', priority: 'HIGH', pct: 100, startOff: -94, endOff: -78, respEmail: ENG, discipline: 'Process', wbs: '1.2', dependsOnKey: 'e1' },
  { key: 'e3', phase: 'Engineering', title: 'P&ID development (IFC)', status: 'IN_PROGRESS', priority: 'HIGH', pct: 70, startOff: -77, endOff: -10, respEmail: ENG, discipline: 'Process', wbs: '1.3', dependsOnKey: 'e2' },
  { key: 'e4', phase: 'Engineering', title: 'Equipment datasheets & specs', status: 'IN_PROGRESS', priority: 'MEDIUM', pct: 55, startOff: -60, endOff: 5, respEmail: ENG, discipline: 'Mechanical', wbs: '1.4', dependsOnKey: 'e2' },
  { key: 'e5', phase: 'Engineering', title: '3D model review (30/60/90%)', status: 'REVIEW', priority: 'MEDIUM', pct: 60, startOff: -40, endOff: 20, respEmail: ENG, discipline: 'Piping', wbs: '1.5', dependsOnKey: 'e3' },
  { key: 'eMS', phase: 'Engineering', title: 'MILESTONE: Engineering 60% complete', status: 'DONE', priority: 'HIGH', pct: 100, startOff: -30, endOff: -30, respEmail: PM, discipline: 'Process', wbs: '1.6', milestone: true, dependsOnKey: 'e3' },
  // Procurement
  { key: 'p1', phase: 'Procurement', title: 'Long-lead equipment RFQ package', status: 'DONE', priority: 'HIGH', pct: 100, startOff: -85, endOff: -60, respEmail: PROC, discipline: 'Mechanical', wbs: '2.1', dependsOnKey: 'e1' },
  { key: 'p2', phase: 'Procurement', title: 'Amine absorber column — PO & expediting', status: 'IN_PROGRESS', priority: 'URGENT', pct: 45, startOff: -55, endOff: 60, respEmail: PROC, discipline: 'Mechanical', wbs: '2.2', dependsOnKey: 'p1' },
  { key: 'p3', phase: 'Procurement', title: 'Gas compressor package — PO', status: 'TODO', priority: 'HIGH', pct: 0, startOff: -20, endOff: 90, respEmail: PROC, discipline: 'Mechanical', wbs: '2.3', dependsOnKey: 'p1' },
  { key: 'p4', phase: 'Procurement', title: 'Bulk piping & valves — material takeoff', status: 'IN_PROGRESS', priority: 'MEDIUM', pct: 30, startOff: -15, endOff: 45, respEmail: PROC, discipline: 'Piping', wbs: '2.4', dependsOnKey: 'e5' },
  { key: 'pMS', phase: 'Procurement', title: 'MILESTONE: All long-lead POs placed', status: 'TODO', priority: 'HIGH', pct: 0, startOff: 60, endOff: 60, respEmail: PM, discipline: 'Mechanical', wbs: '2.5', milestone: true, dependsOnKey: 'p3' },
  // Construction
  { key: 'c1', phase: 'Construction', title: 'Site mobilization & temporary facilities', status: 'DONE', priority: 'HIGH', pct: 100, startOff: -50, endOff: -30, respEmail: CON, discipline: 'Civil', wbs: '3.1', dependsOnKey: 'e1' },
  { key: 'c2', phase: 'Construction', title: 'Civil foundations & underground', status: 'IN_PROGRESS', priority: 'HIGH', pct: 40, startOff: -25, endOff: 40, respEmail: CON, discipline: 'Civil', wbs: '3.2', dependsOnKey: 'c1' },
  { key: 'c3', phase: 'Construction', title: 'Structural steel erection', status: 'TODO', priority: 'MEDIUM', pct: 0, startOff: 40, endOff: 90, respEmail: CON, discipline: 'Civil', wbs: '3.3', dependsOnKey: 'c2' },
  { key: 'c4', phase: 'Construction', title: 'Mechanical equipment installation', status: 'TODO', priority: 'HIGH', pct: 0, startOff: 90, endOff: 150, respEmail: CON, discipline: 'Mechanical', wbs: '3.4', dependsOnKey: 'c3' },
  { key: 'c5', phase: 'Construction', title: 'Piping fabrication & erection', status: 'TODO', priority: 'MEDIUM', pct: 0, startOff: 100, endOff: 170, respEmail: CON, discipline: 'Piping', wbs: '3.5', dependsOnKey: 'c3' },
  { key: 'c6', phase: 'Construction', title: 'E&I installation & cable pulling', status: 'TODO', priority: 'MEDIUM', pct: 0, startOff: 120, endOff: 185, respEmail: CON, discipline: 'Electrical', wbs: '3.6', dependsOnKey: 'c4' },
  { key: 'cMS', phase: 'Construction', title: 'MILESTONE: Mechanical completion', status: 'TODO', priority: 'URGENT', pct: 0, startOff: 190, endOff: 190, respEmail: PM, discipline: 'Mechanical', wbs: '3.7', milestone: true, dependsOnKey: 'c5' },
  // Commissioning
  { key: 'x1', phase: 'Commissioning', title: 'Pre-commissioning, flushing & drying', status: 'TODO', priority: 'HIGH', pct: 0, startOff: 190, endOff: 215, respEmail: QA, discipline: 'Process', wbs: '4.1', dependsOnKey: 'cMS' },
  { key: 'x2', phase: 'Commissioning', title: 'MILESTONE: Ready for start-up (RFSU)', status: 'TODO', priority: 'URGENT', pct: 0, startOff: 220, endOff: 220, respEmail: PM, discipline: 'Process', wbs: '4.2', milestone: true, dependsOnKey: 'x1' },
  { key: 'x3', phase: 'Commissioning', title: 'Performance test run & handover', status: 'TODO', priority: 'HIGH', pct: 0, startOff: 220, endOff: 240, respEmail: QA, discipline: 'Process', wbs: '4.3', dependsOnKey: 'x2' },
];

const PHASE_LABEL: Record<string, string> = {
  Engineering: 'Engineering', Procurement: 'Procurement', Construction: 'Construction', Commissioning: 'Commissioning',
};

async function main(): Promise<void> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@taskhub.local';
  let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    const hash = await argon2.hash('admin', { type: argon2.argon2id });
    admin = await prisma.user.create({
      data: { email: adminEmail, passwordHash: hash, name: 'Admin', globalRole: GlobalRole.ADMIN, isSystemUser: adminEmail.toLowerCase() === 'admin@taskhub.local', emailVerifiedAt: TODAY },
    });
  }

  // Team + roles + memberships
  const team = await prisma.team.upsert({
    where: { slug: TEAM.slug }, update: { name: TEAM.name, color: TEAM.color },
    create: { name: TEAM.name, slug: TEAM.slug, color: TEAM.color },
  });
  const managerRoleId = await ensureSystemRole(team.id, 'Manager', DEFAULT_MANAGER_PERMS);
  const memberRoleId = await ensureSystemRole(team.id, 'Member', DEFAULT_MEMBER_PERMS);
  await ensureSystemRole(team.id, 'PMO', DEFAULT_PMO_PERMS);
  await ensureSystemManagerOnTeam(team.id);

  const demoHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });
  const userId = new Map<string, string>();
  for (const u of USERS) {
    const row = await prisma.user.upsert({
      where: { email: u.email }, update: { name: u.name },
      create: { email: u.email, passwordHash: demoHash, name: u.name, globalRole: GlobalRole.MEMBER, emailVerifiedAt: TODAY },
    });
    userId.set(u.email, row.id);
    await prisma.teamMembership.upsert({
      where: { userId_teamId: { userId: row.id, teamId: team.id } },
      update: { role: u.lead ? TeamRole.MANAGER : TeamRole.MEMBER, roleId: u.lead ? managerRoleId : memberRoleId },
      create: { userId: row.id, teamId: team.id, role: u.lead ? TeamRole.MANAGER : TeamRole.MEMBER, roleId: u.lead ? managerRoleId : memberRoleId },
    });
  }
  await prisma.teamMembership.upsert({
    where: { userId_teamId: { userId: admin.id, teamId: team.id } },
    update: { role: TeamRole.MANAGER, roleId: managerRoleId },
    create: { userId: admin.id, teamId: team.id, role: TeamRole.MANAGER, roleId: managerRoleId },
  });

  // Labels — Label has no @@unique([teamId, name]) (partial indexes), so emulate.
  const labelId = new Map<string, string>();
  for (const l of LABELS) {
    const found = await prisma.label.findFirst({ where: { teamId: team.id, name: l.name } });
    const row = found
      ? await prisma.label.update({ where: { id: found.id }, data: { color: l.color } })
      : await prisma.label.create({ data: { teamId: team.id, name: l.name, color: l.color } });
    labelId.set(l.name, row.id);
  }

  // Custom fields (team-scoped)
  const disciplineField = await prisma.customFieldDefinition.upsert({
    where: { teamId_name: { teamId: team.id, name: 'Discipline' } },
    update: {},
    create: { teamId: team.id, name: 'Discipline', type: 'SINGLE_SELECT', description: 'Engineering discipline', position: 0 },
  });
  const DISC_OPTS = ['Process', 'Piping', 'Civil', 'Electrical', 'Instrumentation', 'Mechanical'];
  const discOptId = new Map<string, string>();
  for (let i = 0; i < DISC_OPTS.length; i++) {
    const o = await prisma.customFieldOption.upsert({
      where: { fieldId_label: { fieldId: disciplineField.id, label: DISC_OPTS[i]! } },
      update: {}, create: { fieldId: disciplineField.id, label: DISC_OPTS[i]!, position: i },
    });
    discOptId.set(DISC_OPTS[i]!, o.id);
  }
  const wbsField = await prisma.customFieldDefinition.upsert({
    where: { teamId_name: { teamId: team.id, name: 'WBS Code' } }, update: {},
    create: { teamId: team.id, name: 'WBS Code', type: 'TEXT', description: 'Work breakdown structure code', position: 1 },
  });
  const pkgField = await prisma.customFieldDefinition.upsert({
    where: { teamId_name: { teamId: team.id, name: 'Contract Package' } }, update: {},
    create: { teamId: team.id, name: 'Contract Package', type: 'SINGLE_SELECT', description: 'EPC contract package', position: 2 },
  });
  const PKG_OPTS = ['P1 — Engineering', 'P2 — Procurement', 'P3 — Construction'];
  const pkgOptId = new Map<string, string>();
  for (let i = 0; i < PKG_OPTS.length; i++) {
    const o = await prisma.customFieldOption.upsert({
      where: { fieldId_label: { fieldId: pkgField.id, label: PKG_OPTS[i]! } },
      update: {}, create: { fieldId: pkgField.id, label: PKG_OPTS[i]!, position: i },
    });
    pkgOptId.set(PKG_OPTS[i]!, o.id);
  }

  // ── Flagship project ──────────────────────────────────────────────────────
  const existing = await prisma.project.findFirst({ where: { teamId: team.id, code: 'SP14-GSU' } });
  if (existing) {
    console.log('EPC demo already present (project SP14-GSU exists) — nothing to do.');
    return;
  }

  const epcProfile = await prisma.projectProfile.findFirst({ where: { key: 'EPC', ownerScope: 'SYSTEM' } });
  const profileOverrides = Object.fromEntries(ALL_MODULES.map((k) => [k, { enabled: true }]));

  const project = await prisma.project.create({
    data: {
      teamId: team.id,
      ownerId: userId.get(PM)!,
      accountableId: userId.get(PM)!,
      name: 'South Pars Phase 14 — Gas Sweetening Unit',
      code: 'SP14-GSU',
      description: 'EPC delivery of a 500 MMSCFD amine gas-sweetening unit: engineering, procurement of long-lead equipment, site construction and commissioning through to first gas.',
      status: 'ACTIVE',
      plannedBudget: 48_500_000,
      budgetCurrency: 'USD',
      startDate: addDays(TODAY, -120),
      endDate: addDays(TODAY, 240),
      correspondenceEnabled: true,
      ragStatus: 'AMBER',
      ragReason: 'Amine absorber column PO slippage threatens the mechanical-completion milestone; recovery plan in progress.',
      healthUpdatedAt: TODAY,
      profileId: epcProfile?.id ?? null,
      profileVersion: epcProfile?.version ?? null,
      profileOverrides,
    },
  });

  // Attach phase labels to the project
  for (const name of ['Engineering', 'Procurement', 'Construction', 'Commissioning']) {
    await prisma.projectLabel.create({ data: { projectId: project.id, labelId: labelId.get(name)! } });
  }

  // ── WBS summary nodes (one per phase) + leaf tasks ────────────────────────
  let position = 0;
  const phaseSummaryId = new Map<string, string>();
  const phaseSummaryPath = new Map<string, string>();
  const phaseWbs: Record<string, string> = { Engineering: '1', Procurement: '2', Construction: '3', Commissioning: '4' };
  let phaseOrder = 0;
  for (const phase of ['Engineering', 'Procurement', 'Construction', 'Commissioning'] as const) {
    const s = await prisma.task.create({
      data: {
        projectId: project.id, teamId: team.id, creatorId: admin.id,
        responsibleId: userId.get(PM)!, title: `${phase} phase`, status: 'IN_PROGRESS',
        priority: 'MEDIUM', isSummary: true, wbsOrder: phaseOrder, wbsDepth: 0,
        percentComplete: 0, percentCompleteMode: 'FROM_CHILDREN', position: position++,
      },
    });
    await prisma.task.update({ where: { id: s.id }, data: { wbsPath: `/${s.id}` } });
    phaseSummaryId.set(phase, s.id);
    phaseSummaryPath.set(phase, `/${s.id}`);
    await prisma.taskLabel.create({ data: { taskId: s.id, labelId: labelId.get(PHASE_LABEL[phase]!)! } });
    phaseOrder++;
  }

  const taskId = new Map<string, string>();
  const taskDates = new Map<string, { start: Date; end: Date }>();
  let leafOrder = 0;
  for (const t of TASKS) {
    const start = addDays(TODAY, t.startOff);
    const end = addDays(TODAY, t.endOff);
    const done = t.status === 'DONE';
    const created = await prisma.task.create({
      data: {
        projectId: project.id, teamId: team.id, creatorId: admin.id,
        assigneeId: userId.get(t.respEmail)!, responsibleId: userId.get(t.respEmail)!,
        parentId: phaseSummaryId.get(t.phase)!,
        title: t.title, status: t.status, priority: t.priority,
        startDate: start, plannedDate: end, dueDate: end,
        baselineStart: start, baselineEnd: end,
        actualStart: done || t.pct > 0 ? start : null,
        actualEnd: done ? end : null,
        completedAt: done ? end : null,
        percentComplete: t.pct, percentCompleteMode: 'MANUAL',
        isMilestone: !!t.milestone, milestoneKind: t.milestone ? 'FINISH' : null,
        wbsOrder: leafOrder, wbsDepth: 1, wbsPath: `${phaseSummaryPath.get(t.phase)}/PLACEHOLDER`,
        position: position++,
      },
    });
    await prisma.task.update({ where: { id: created.id }, data: { wbsPath: `${phaseSummaryPath.get(t.phase)}/${created.id}` } });
    taskId.set(t.key, created.id);
    taskDates.set(t.key, { start, end });
    leafOrder++;

    // Labels: phase + milestone/HSE/quality accents
    await prisma.taskLabel.create({ data: { taskId: created.id, labelId: labelId.get(PHASE_LABEL[t.phase]!)! } });
    if (t.milestone) await prisma.taskLabel.create({ data: { taskId: created.id, labelId: labelId.get('Milestone')! } });

    // Custom field values: Discipline (select), WBS Code (text), Package (select)
    const discVal = await prisma.customFieldValue.create({ data: { fieldId: disciplineField.id, taskId: created.id } });
    await prisma.customFieldValueOption.create({ data: { valueId: discVal.id, optionId: discOptId.get(t.discipline)! } });
    await prisma.customFieldValue.create({ data: { fieldId: wbsField.id, taskId: created.id, valueText: t.wbs } });
    const pkg = t.phase === 'Engineering' ? PKG_OPTS[0]! : t.phase === 'Procurement' ? PKG_OPTS[1]! : PKG_OPTS[2]!;
    const pkgVal = await prisma.customFieldValue.create({ data: { fieldId: pkgField.id, taskId: created.id } });
    await prisma.customFieldValueOption.create({ data: { valueId: pkgVal.id, optionId: pkgOptId.get(pkg)! } });
  }

  // Mark summaries as having children
  for (const id of phaseSummaryId.values()) {
    await prisma.task.update({ where: { id }, data: { isSummary: true } });
  }

  // Dependencies (FS network)
  for (const t of TASKS) {
    if (!t.dependsOnKey) continue;
    const from = taskId.get(t.key)!;
    const dep = taskId.get(t.dependsOnKey);
    if (!dep) continue;
    await prisma.taskDependency.create({
      data: { teamId: team.id, taskId: from, dependsOnId: dep, type: 'FINISH_TO_START', lag: 0, lagUnit: 'DAY', calendarMode: 'WORKING' },
    });
  }

  // RACI (Consulted / Informed) on key tasks
  const raciTargets = ['e3', 'p2', 'c2', 'c4', 'x1'];
  for (const k of raciTargets) {
    const id = taskId.get(k);
    if (!id) continue;
    await prisma.taskRaci.create({ data: { taskId: id, userId: userId.get(QA)!, role: 'CONSULTED' } });
    await prisma.taskRaci.create({ data: { taskId: id, userId: userId.get('nasrin.jafari@epc.local')!, role: 'INFORMED' } });
  }

  // Subtasks on a few tasks
  const subDefs: Record<string, string[]> = {
    e3: ['Issue P&IDs for review (IFR)', 'Incorporate 30% review comments', 'Issue for construction (IFC)'],
    p2: ['Technical bid evaluation', 'Commercial bid evaluation', 'Place purchase order', 'Kick-off & expediting plan'],
    c2: ['Excavation & piling', 'Rebar & formwork', 'Concrete pour & curing'],
  };
  for (const [k, subs] of Object.entries(subDefs)) {
    const id = taskId.get(k);
    if (!id) continue;
    for (let i = 0; i < subs.length; i++) {
      const isDone = k === 'c2' ? i === 0 : k === 'e3' ? i === 0 : false;
      await prisma.subtask.create({
        data: {
          taskId: id, title: subs[i]!, position: i,
          done: isDone, status: isDone ? 'DONE' : i === 1 ? 'IN_PROGRESS' : 'NOT_STARTED',
          responsibleId: userId.get(ENG)!, assigneeId: userId.get(QA)!,
        },
      });
    }
  }

  // Comments
  const commentDefs: Array<[string, string, string]> = [
    ['p2', PM, 'Vendor slipped the delivery by 6 weeks. Escalating — see risk RISK-002 and change request CR-001.'],
    ['e3', ENG, 'P&IDs at 70%. Awaiting vendor GA drawings for the compressor package before we can freeze the utility headers.'],
    ['c2', CON, 'Foundation concrete pour for the absorber area completed and cured. QC cube tests passed at 28 days.'],
  ];
  for (const [k, email, body] of commentDefs) {
    const id = taskId.get(k);
    if (!id) continue;
    await prisma.comment.create({ data: { taskId: id, authorId: userId.get(email)!, body } });
  }

  // ── Correspondence (دبیرخانه): contacts + counter + letters ───────────────
  const clientContact = await prisma.contact.create({ data: { teamId: team.id, name: 'NIOC — Project Directorate', organization: 'National Iranian Oil Company', type: 'ORG', email: 'projects@nioc.example', createdById: admin.id } });
  const vendorContact = await prisma.contact.create({ data: { teamId: team.id, name: 'Petropars Fabrication Yard', organization: 'Petropars Ltd', type: 'ORG', email: 'yard@petropars.example', createdById: admin.id } });
  const pmContact = await prisma.contact.create({ data: { teamId: team.id, name: 'Farhad Ahmadi (PMT)', organization: 'EPC Contractor', type: 'PERSON', email: PM, createdById: admin.id } });

  const jalaliYear = 1404;
  const letters = [
    { dir: 'INCOMING', subj: 'Notice to Proceed — SP14 Gas Sweetening Unit', status: 'RECEIVED', sender: clientContact.id, recipient: pmContact.id, off: -118 },
    { dir: 'OUTGOING', subj: 'Submission of IFC P&IDs Rev. B for approval', status: 'SENT', sender: pmContact.id, recipient: clientContact.id, off: -12 },
    { dir: 'OUTGOING', subj: 'Request for approval — Amine absorber vendor substitution', status: 'SENT', sender: pmContact.id, recipient: clientContact.id, off: -6 },
    { dir: 'INCOMING', subj: 'Fabrication progress report — Absorber column (Week 22)', status: 'RECEIVED', sender: vendorContact.id, recipient: pmContact.id, off: -3 },
  ] as const;
  for (let i = 0; i < letters.length; i++) {
    const l = letters[i]!;
    const seq = i + 1;
    await prisma.correspondence.create({
      data: {
        teamId: team.id, projectId: project.id, direction: l.dir, subject: l.subj,
        letterDate: addDays(TODAY, l.off), jalaliYear, sequence: seq,
        referenceNumber: `${jalaliYear}-${String(seq).padStart(3, '0')}`, status: l.status,
        senderId: l.sender, recipientId: l.recipient, createdById: admin.id,
      },
    });
  }
  await prisma.correspondenceCounter.create({ data: { projectId: project.id, jalaliYear, currentValue: letters.length } });

  // ── Cost control (CBS / budget / commitments / actuals / expenses) ─────────
  const rootAcct = await prisma.costAccount.create({ data: { teamId: team.id, projectId: project.id, code: '00', name: 'SP14-GSU (all)', path: '/root', isDefault: true } });
  await prisma.costAccount.update({ where: { id: rootAcct.id }, data: { path: `/${rootAcct.id}` } });
  const acctDefs = [
    { code: '10', name: 'Engineering', budget: 6_000_000 },
    { code: '20', name: 'Procurement', budget: 28_000_000 },
    { code: '30', name: 'Construction', budget: 12_000_000 },
    { code: '40', name: 'Commissioning', budget: 2_500_000 },
  ];
  const acctId = new Map<string, string>();
  for (const a of acctDefs) {
    const acc = await prisma.costAccount.create({
      data: { teamId: team.id, projectId: project.id, parentId: rootAcct.id, code: a.code, name: a.name, path: `/${rootAcct.id}/tmp` },
    });
    await prisma.costAccount.update({ where: { id: acc.id }, data: { path: `/${rootAcct.id}/${acc.id}` } });
    acctId.set(a.name, acc.id);
    await prisma.budgetLine.create({
      data: { teamId: team.id, projectId: project.id, costAccountId: acc.id, amountMinor: usd(a.budget), currency: 'USD', source: 'MANUAL', note: `${a.name} control budget` },
    });
  }
  // Commitment (PO obligation) on Procurement
  await prisma.commitment.create({
    data: { teamId: team.id, projectId: project.id, costAccountId: acctId.get('Procurement')!, vendorName: 'Petropars Ltd', reference: 'PO-2201', amountMinor: usd(9_800_000), currency: 'USD', status: 'OPEN', incurredOn: addDays(TODAY, -50) },
  });
  // Expense (approved) on Construction
  const expense = await prisma.expense.create({
    data: { teamId: team.id, projectId: project.id, costAccountId: acctId.get('Construction')!, amountMinor: usd(42_000), currency: 'USD', status: 'APPROVED', description: 'Site temporary power & fuel — month 2', incurredOn: addDays(TODAY, -35), submittedById: userId.get(CON)!, decidedById: userId.get(PM)!, decidedAt: addDays(TODAY, -33) },
  });
  // Actual cost ledger (append-only)
  const actuals = [
    { acct: 'Engineering', src: 'TIMESHEET', amt: 3_150_000, off: -20, desc: 'Engineering labour to date' },
    { acct: 'Procurement', src: 'INVOICE', amt: 4_600_000, off: -15, desc: 'Absorber column milestone payment 1' },
    { acct: 'Construction', src: 'EXPENSE', amt: 42_000, off: -33, desc: 'Site temporary power & fuel', expId: expense.id },
    { acct: 'Construction', src: 'INVOICE', amt: 1_950_000, off: -10, desc: 'Civil subcontractor progress claim 1' },
  ] as const;
  for (const a of actuals) {
    await prisma.actualCostEntry.create({
      data: {
        teamId: team.id, projectId: project.id, costAccountId: acctId.get(a.acct)!, source: a.src,
        amountMinor: usd(a.amt), currency: 'USD', baseAmountMinor: usd(a.amt), baseCurrency: 'USD',
        incurredOn: addDays(TODAY, a.off), description: a.desc, createdById: admin.id,
        sourceExpenseId: 'expId' in a ? (a as { expId: string }).expId : null,
      },
    });
  }

  // ── Timesheets + rate cards ────────────────────────────────────────────────
  for (const u of USERS) {
    await prisma.rateCard.create({
      data: { teamId: team.id, scope: 'USER', userId: userId.get(u.email)!, costRateMinor: usd(u.lead ? 95 : 70), billRateMinor: usd(u.lead ? 160 : 120), currency: 'USD', effectiveFrom: addDays(TODAY, -130) },
    });
  }
  const period = await prisma.timesheetPeriod.create({
    data: { teamId: team.id, userId: userId.get(ENG)!, periodStart: addDays(TODAY, -14), periodEnd: addDays(TODAY, -8), status: 'APPROVED', submittedAt: addDays(TODAY, -7), decidedAt: addDays(TODAY, -6), decidedById: userId.get(PM)! },
  });
  for (let d = 0; d < 5; d++) {
    await prisma.timeEntry.create({
      data: { teamId: team.id, userId: userId.get(ENG)!, projectId: project.id, taskId: taskId.get('e3')!, periodId: period.id, date: addDays(TODAY, -14 + d), minutes: 480, billable: true, note: 'P&ID development', costRateMinorSnapshot: usd(95), currencySnapshot: 'USD' },
    });
  }

  // ── Resources + assignments ────────────────────────────────────────────────
  const weldSkill = await prisma.skill.create({ data: { teamId: team.id, name: 'ASME IX Welding' } });
  const resIds: string[] = [];
  const humanRes = [ENG, CON, QA];
  for (const email of humanRes) {
    const r = await prisma.resource.create({ data: { teamId: team.id, name: USERS.find((u) => u.email === email)!.name, type: 'HUMAN', userId: userId.get(email)!, maxUnits: 1, costRateMinor: usd(90), currency: 'USD' } });
    resIds.push(r.id);
  }
  const crane = await prisma.resource.create({ data: { teamId: team.id, name: 'Crawler Crane 250t', type: 'EQUIPMENT', maxUnits: 1, costRateMinor: usd(1_200), currency: 'USD' } });
  await prisma.resource.create({ data: { teamId: team.id, name: 'Carbon Steel Pipe (bulk)', type: 'MATERIAL', maxUnits: 1 } });
  const welder = await prisma.resource.create({ data: { teamId: team.id, name: 'Welding Crew A', type: 'HUMAN', maxUnits: 4, costRateMinor: usd(60), currency: 'USD' } });
  await prisma.resourceSkill.create({ data: { resourceId: welder.id, skillId: weldSkill.id, level: 3 } });
  await prisma.resourceAssignment.create({ data: { teamId: team.id, projectId: project.id, taskId: taskId.get('c2')!, resourceId: crane.id, units: 1, plannedHours: 320, actualHours: 128 } });
  await prisma.resourceAssignment.create({ data: { teamId: team.id, projectId: project.id, taskId: taskId.get('c5')!, resourceId: welder.id, units: 1, plannedHours: 640 } });
  await prisma.resourceAssignment.create({ data: { teamId: team.id, projectId: project.id, taskId: taskId.get('e3')!, resourceId: resIds[0]!, units: 0.8, plannedHours: 400, actualHours: 280 } });

  // ── EVM snapshots ──────────────────────────────────────────────────────────
  const bac = usd(48_500_000);
  const evmRows = [
    { off: -60, pv: 8_000_000, ev: 7_200_000, ac: 7_600_000 },
    { off: -30, pv: 14_000_000, ev: 12_400_000, ac: 13_100_000 },
    { off: 0, pv: 19_500_000, ev: 17_100_000, ac: 18_300_000 },
  ];
  for (const r of evmRows) {
    const pv = usd(r.pv), ev = usd(r.ev), ac = usd(r.ac);
    const cv = ev - ac, sv = ev - pv;
    const cpi = r.ev / r.ac, spi = r.ev / r.pv;
    const eacDollars = 48_500_000 / cpi;
    const eac = usd(eacDollars), vac = bac - eac;
    const tcpi = (48_500_000 - r.ev) / (48_500_000 - r.ac);
    await prisma.evmSnapshot.create({
      data: {
        teamId: team.id, projectId: project.id, snapshotDate: addDays(TODAY, r.off),
        bac, pv, ev, ac, cv, sv, cpi: cpi.toFixed(4), spi: spi.toFixed(4), eac, eacMethod: 'CPI_BASED', vac, tcpi: tcpi.toFixed(4), currency: 'USD',
      },
    });
  }

  // ── Baseline ───────────────────────────────────────────────────────────────
  const baseline = await prisma.projectBaseline.create({
    data: {
      projectId: project.id, teamId: team.id, name: 'Contract Baseline Rev 0', source: 'MANUAL', isCurrent: true,
      capturedById: admin.id,
      snapshot: { capturedAt: TODAY.toISOString(), taskCount: TASKS.length, note: 'Baseline at contract award.' },
    },
  });
  for (const t of TASKS) {
    const d = taskDates.get(t.key)!;
    await prisma.baselineEntry.create({ data: { baselineId: baseline.id, taskId: taskId.get(t.key)!, start: d.start, end: d.end } });
  }

  // ── Risk register ──────────────────────────────────────────────────────────
  const risks = [
    { ref: 'RISK-001', title: 'Long-lead absorber column delivery slippage', p: 4, i: 5, resp: 'MITIGATE', plan: 'Expedite vendor; evaluate alternate fabricator; resequence construction.', owner: PROC, off: 45 },
    { ref: 'RISK-002', title: 'Summer heat stress impacts site productivity', p: 3, i: 3, resp: 'MITIGATE', plan: 'Adjust shift pattern; hydration & rest protocol per HSE plan.', owner: 'nasrin.jafari@epc.local', off: 90 },
    { ref: 'RISK-003', title: 'FX exposure on imported equipment', p: 3, i: 4, resp: 'TRANSFER', plan: 'Hedge USD payments; fix contract currency clauses.', owner: PM, off: 60 },
    { ref: 'RISK-004', title: 'Interface clashes found late in 3D model', p: 2, i: 3, resp: 'MITIGATE', plan: 'Mandatory 60% & 90% model reviews with all disciplines.', owner: ENG, off: 20 },
  ] as const;
  for (const r of risks) {
    await prisma.riskRecord.create({
      data: { teamId: team.id, projectId: project.id, reference: r.ref, title: r.title, probability: r.p, impact: r.i, score: r.p * r.i, response: r.resp, mitigationPlan: r.plan, ownerId: userId.get(r.owner)!, dueDate: addDays(TODAY, r.off), createdById: admin.id },
    });
  }

  // ── Change requests ────────────────────────────────────────────────────────
  await prisma.changeRequest.create({
    data: { teamId: team.id, projectId: project.id, reference: 'CR-001', title: 'Absorber column vendor substitution', description: 'Substitute nominated absorber vendor due to 6-week delivery slippage. Net schedule +14 days, cost +$0.35M.', status: 'SUBMITTED', scheduleDeltaDays: 14, costImpactMinor: usd(350_000), costCurrency: 'USD', submittedById: userId.get(PROC)!, submittedAt: addDays(TODAY, -5) },
  });
  await prisma.changeRequest.create({
    data: { teamId: team.id, projectId: project.id, reference: 'CR-002', title: 'Add spare export pump per client request', description: 'Client-requested N+1 export pump. Cost +$0.62M, schedule neutral.', status: 'DRAFT', scheduleDeltaDays: 0, costImpactMinor: usd(620_000), costCurrency: 'USD' },
  });

  // ── Procurement: vendors, contracts, POs ───────────────────────────────────
  const vendors = [
    { name: 'Petropars Ltd', email: 'procurement@petropars.example' },
    { name: 'Siemens Energy', email: 'sales@siemens-energy.example' },
    { name: 'Isfahan Steel Co', email: 'sales@isfahansteel.example' },
  ];
  const vendorId = new Map<string, string>();
  for (const v of vendors) {
    const row = await prisma.vendor.create({ data: { teamId: team.id, name: v.name, contactEmail: v.email } });
    vendorId.set(v.name, row.id);
  }
  const absorberContract = await prisma.contract.create({
    data: { teamId: team.id, projectId: project.id, vendorId: vendorId.get('Petropars Ltd')!, reference: 'CTR-2201', title: 'Amine absorber column — supply & fabrication', status: 'ACTIVE', valueMinor: usd(9_800_000), currency: 'USD', startDate: addDays(TODAY, -55), endDate: addDays(TODAY, 60), createdById: userId.get(PROC)! },
  });
  await prisma.contract.create({
    data: { teamId: team.id, projectId: project.id, vendorId: vendorId.get('Siemens Energy')!, reference: 'CTR-2202', title: 'Gas compressor package', status: 'DRAFT', valueMinor: usd(11_200_000), currency: 'USD', createdById: userId.get(PROC)! },
  });
  await prisma.purchaseOrder.create({
    data: { teamId: team.id, projectId: project.id, contractId: absorberContract.id, reference: 'PO-2201', title: 'Absorber column — fabrication release', status: 'ISSUED', amountMinor: usd(9_800_000), currency: 'USD', issuedDate: addDays(TODAY, -50), expectedDate: addDays(TODAY, 60), createdById: userId.get(PROC)! },
  });
  await prisma.purchaseOrder.create({
    data: { teamId: team.id, projectId: project.id, reference: 'PO-2210', title: 'Structural steel — bulk supply', status: 'DRAFT', amountMinor: usd(2_400_000), currency: 'USD', createdById: userId.get(PROC)! },
  });

  // ── Quality NCRs ───────────────────────────────────────────────────────────
  await prisma.qualityNcr.create({
    data: { teamId: team.id, projectId: project.id, reference: 'NCR-001', title: 'Foundation concrete cube test below spec — Grid C4', description: '7-day cube strength 3% below target; 28-day passed.', severity: 'MINOR', disposition: 'USE_AS_IS', closedAt: addDays(TODAY, -8), createdById: userId.get(QA)! },
  });
  await prisma.qualityNcr.create({
    data: { teamId: team.id, projectId: project.id, reference: 'NCR-002', title: 'Welding porosity on spool SP-114-032', description: 'RT revealed porosity exceeding ASME B31.3 limits.', severity: 'MAJOR', disposition: 'REWORK', correctiveTaskId: taskId.get('c5')!, createdById: userId.get(QA)! },
  });
  await prisma.qualityNcr.create({
    data: { teamId: team.id, projectId: project.id, reference: 'NCR-003', title: 'Absorber internals coating thickness non-conformance', description: 'DFT below minimum on 12% of measured points.', severity: 'MAJOR', disposition: null, createdById: userId.get(QA)! },
  });

  // ── PMIS records (issues / RFIs / documents / stakeholders / MoM) ──────────
  const recordTypes = await prisma.pmisRecordType.findMany({ where: { OR: [{ teamId: null }, { teamId: team.id }] } });
  const recSamples: Record<string, { title: string; desc: string }[]> = {
    issue: [{ title: 'Utility header routing clash in Unit 114', desc: 'Clash between firewater and instrument air headers at EL+6.0m.' }],
    rfi: [{ title: 'RFI — Confirm absorber nozzle orientation', desc: 'Vendor GA shows N4 at 45°, IFC P&ID implies 90°. Please confirm.' }],
    document: [{ title: 'Transmittal TR-0087 — IFC P&IDs Rev B', desc: 'Issued to client for approval; 12 sheets.' }],
    stakeholder: [{ title: 'NIOC Project Directorate', desc: 'Client. High influence, high interest — weekly progress meeting.' }],
    mom: [{ title: 'MoM — Weekly progress meeting W22', desc: 'Absorber slippage, CR-001 raised, HSE stats reviewed.' }],
  };
  let recCount = 0;
  for (const rt of recordTypes) {
    const key = rt.key.toLowerCase();
    const matchKey = Object.keys(recSamples).find((k) => key.includes(k));
    if (!matchKey) continue;
    const samples = recSamples[matchKey]!;
    for (let i = 0; i < samples.length; i++) {
      try {
        await prisma.pmisRecord.create({
          data: { teamId: team.id, projectId: project.id, recordTypeId: rt.id, reference: `${rt.key.toUpperCase()}-${String(i + 1).padStart(3, '0')}`, title: samples[i]!.title, description: samples[i]!.desc, status: 'OPEN', assigneeId: userId.get(ENG)!, createdById: admin.id },
        });
        recCount++;
      } catch { /* reference collision — skip */ }
    }
  }

  // ── Intake form (Site RFI / change request) ────────────────────────────────
  const form = await prisma.intakeForm.create({
    data: { teamId: team.id, projectId: project.id, name: 'Site RFI / Change Request', description: 'Field-originated requests for information or change, routed into the project WBS.', mode: 'TEAM', enabled: true, createdById: admin.id },
  });
  const formFields = [
    { label: 'Subject', target: 'title', required: true, pos: 0, cf: null as string | null },
    { label: 'Details', target: 'description', required: true, pos: 1, cf: null },
    { label: 'Priority', target: 'priority', required: false, pos: 2, cf: null },
    { label: 'Needed by', target: 'dueDate', required: false, pos: 3, cf: null },
    { label: 'Discipline', target: 'customField', required: true, pos: 4, cf: disciplineField.id },
  ];
  for (const f of formFields) {
    await prisma.intakeFormField.create({ data: { formId: form.id, label: f.label, target: f.target, required: f.required, position: f.pos, customFieldId: f.cf } });
  }

  // ── Automation rule ────────────────────────────────────────────────────────
  const rule = await prisma.automationRule.create({
    data: { teamId: team.id, name: 'Flag URGENT tasks for HSE review', description: 'When a task is created as URGENT, tag it HSE and notify the HSE lead.', enabled: true, triggerType: 'task.created', conditionMatch: 'ALL', createdById: admin.id },
  });
  await prisma.automationCondition.create({ data: { ruleId: rule.id, factType: 'priority', operator: 'is', valueJson: { priority: 'URGENT' } } });
  await prisma.automationAction.create({ data: { ruleId: rule.id, actionType: 'add_label', valueJson: { labelId: labelId.get('HSE')! }, position: 0 } });
  await prisma.automationAction.create({ data: { ruleId: rule.id, actionType: 'send_notification', valueJson: { userId: userId.get('nasrin.jafari@epc.local')! }, position: 1 } });

  // ── Webhook ────────────────────────────────────────────────────────────────
  await prisma.webhook.create({
    data: { teamId: team.id, name: 'MS Teams — project channel', url: 'https://example.webhook.local/epc/southpars', secretEnc: 'demo-not-a-real-secret', events: ['task.created', 'task.updated', 'comment.added'], active: true },
  });

  // ── Dashboard + widgets ────────────────────────────────────────────────────
  const dash = await prisma.dashboard.create({
    data: { teamId: team.id, ownerId: userId.get(PM)!, name: 'EPC Control Room', description: 'Live status of the South Pars Gas Sweetening Unit.', shared: true, position: 0 },
  });
  const widgets = [
    { type: 'METRIC', title: 'Open tasks', dataSource: 'task_count', groupBy: null as string | null, filtersJson: { match: 'ALL', conditions: [{ field: 'status', op: 'in', value: ['TODO', 'IN_PROGRESS', 'REVIEW'] }] } },
    { type: 'BAR', title: 'Tasks by status', dataSource: 'task_count', groupBy: 'status', filtersJson: null },
    { type: 'PIE', title: 'Tasks by priority', dataSource: 'task_count', groupBy: 'priority', filtersJson: null },
    { type: 'BAR', title: 'Tasks by assignee', dataSource: 'task_count', groupBy: 'assignee', filtersJson: null },
  ];
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i]!;
    await prisma.dashboardWidget.create({
      data: { dashboardId: dash.id, type: w.type, title: w.title, dataSource: w.dataSource, groupBy: w.groupBy, filtersJson: w.filtersJson ?? undefined, position: i },
    });
  }

  console.log('EPC demo seed complete.');
  console.log(`  team:      ${TEAM.name} (${TEAM.slug})`);
  console.log(`  project:   ${project.name} [${project.code}]`);
  console.log(`  users:     *@epc.local / ${DEMO_PASSWORD}`);
  console.log(`  tasks:     ${TASKS.length} leaves + 4 phase summaries`);
  console.log(`  registers: ${risks.length} risks, 2 CRs, 3 vendors, 2 contracts, 2 POs, 3 NCRs, ${recCount} PMIS records`);
  console.log(`  cost:      5 accounts, 4 budget lines, 1 commitment, 1 expense, ${actuals.length} ledger entries, 3 EVM snapshots`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
