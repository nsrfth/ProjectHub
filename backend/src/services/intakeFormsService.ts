import { randomBytes } from 'node:crypto';
import type { CustomFieldType, GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import { getSystemUser, getSystemUserId, ensureSystemManagerOnTeam } from '../lib/systemUser.js';
import { TasksService } from './tasksService.js';
import { CustomFieldsService } from './customFieldsService.js';
import { LabelsService } from './labelsService.js';
import type {
  CreateIntakeFormBody,
  IntakeFormFieldInput,
  IntakeFormSubmitBody,
  UpdateIntakeFormBody,
} from '../schemas/intakeForms.js';
import type { SetTaskCustomFieldValueBody } from '../schemas/customFields.js';

const BUILTIN_TARGETS = new Set([
  'title',
  'description',
  'priority',
  'dueDate',
  'assignee',
  'labels',
]);

const PERSON_TYPE: CustomFieldType = 'PERSON';

type FormWithFields = Prisma.IntakeFormGetPayload<{
  include: {
    fields: {
      include: { customField: { include: { options: true } } };
    };
  };
}>;

export interface IntakeFormFieldView {
  id: string;
  label: string;
  target: string;
  customFieldId: string | null;
  customFieldType: CustomFieldType | null;
  required: boolean;
  helpText: string | null;
  position: number;
  options?: { id: string; label: string; color: string | null }[];
}

export interface IntakeFormView {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  mode: string;
  publicToken: string | null;
  enabled: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  fields: IntakeFormFieldView[];
}

function generatePublicToken(): string {
  return randomBytes(32).toString('base64url');
}

function fieldInclude() {
  return {
    fields: {
      orderBy: { position: 'asc' as const },
      include: {
        customField: { include: { options: { orderBy: { position: 'asc' as const } } } },
      },
    },
  };
}

function serializeField(
  f: FormWithFields['fields'][number],
  publicMode: boolean,
  teamLabels?: { id: string; label: string; color: string | null }[],
): IntakeFormFieldView {
  const cf = f.customField;
  const base: IntakeFormFieldView = {
    id: f.id,
    label: f.label,
    target: f.target,
    customFieldId: f.customFieldId,
    customFieldType: cf?.type ?? null,
    required: f.required,
    helpText: f.helpText,
    position: f.position,
  };
  if (f.target === 'labels' && teamLabels) {
    base.options = teamLabels.map((l) => ({ id: l.id, label: l.label, color: l.color }));
  } else if (cf && (cf.type === 'SINGLE_SELECT' || cf.type === 'MULTI_SELECT')) {
    base.options = cf.options.map((o) => ({ id: o.id, label: o.label, color: o.color }));
  }
  if (publicMode && f.target === 'assignee') {
    throw Errors.internal('Public form render included assignee field');
  }
  if (publicMode && cf?.type === PERSON_TYPE) {
    throw Errors.internal('Public form render included person custom field');
  }
  return base;
}

async function labelOptionsForForm(form: FormWithFields) {
  const needsLabels = form.fields.some((f) => f.target === 'labels');
  if (!needsLabels) return undefined;
  const rows = await prisma.label.findMany({
    where: { teamId: form.teamId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true },
  });
  return rows.map((l) => ({ id: l.id, label: l.name, color: l.color }));
}

async function toView(form: FormWithFields, publicMode = false): Promise<IntakeFormView> {
  const teamLabels = await labelOptionsForForm(form);
  return {
    id: form.id,
    teamId: form.teamId,
    projectId: form.projectId,
    name: form.name,
    description: form.description,
    mode: form.mode,
    publicToken: form.publicToken,
    enabled: form.enabled,
    createdById: form.createdById,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    fields: form.fields.map((f) => serializeField(f, publicMode, teamLabels)),
  };
}

function validateFieldDefs(
  teamId: string,
  fields: IntakeFormFieldInput[],
  mode: string,
): void {
  const titleFields = fields.filter((f) => f.target === 'title');
  if (titleFields.length !== 1) {
    throw Errors.badRequest('Exactly one title field is required');
  }
  if (!titleFields[0]!.required) {
    throw Errors.badRequest('The title field must be marked required');
  }

  for (const f of fields) {
    if (f.target === 'customField') {
      if (!f.customFieldId) {
        throw Errors.badRequest('customField target requires customFieldId');
      }
    } else if (f.customFieldId) {
      throw Errors.badRequest('customFieldId is only valid for customField target');
    }
    if (!BUILTIN_TARGETS.has(f.target) && f.target !== 'customField') {
      throw Errors.badRequest(`Unknown field target: ${f.target}`);
    }
  }

  if (mode === 'PUBLIC') {
    for (const f of fields) {
      if (f.target === 'assignee') {
        throw Errors.badRequest('Assignee fields are not allowed on public forms');
      }
    }
  }
}

async function validateCustomFieldsForForm(
  teamId: string,
  fields: IntakeFormFieldInput[],
  mode: string,
): Promise<void> {
  for (const f of fields) {
    if (f.target !== 'customField' || !f.customFieldId) continue;
    const def = await prisma.customFieldDefinition.findUnique({ where: { id: f.customFieldId } });
    if (!def || def.teamId !== teamId) {
      throw Errors.badRequest('Custom field not found in this team');
    }
    if (mode === 'PUBLIC' && def.type === PERSON_TYPE) {
      throw Errors.badRequest('Person custom fields are not allowed on public forms');
    }
  }
}

async function ensureProjectInTeam(teamId: string, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.teamId !== teamId) throw Errors.notFound('Project not found');
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  return String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function toCustomFieldBody(
  type: CustomFieldType,
  raw: unknown,
): SetTaskCustomFieldValueBody {
  switch (type) {
    case 'TEXT':
      return { valueText: asString(raw) };
    case 'NUMBER':
      return { valueNumber: raw as number | string | null };
    case 'DATE':
      return { valueDate: asString(raw) };
    case 'CHECKBOX':
      return { valueBool: raw === true || raw === 'true' };
    case 'PERSON':
      return { valueUserId: asString(raw) };
    case 'SINGLE_SELECT':
    case 'MULTI_SELECT': {
      const ids = asStringArray(raw);
      return { optionIds: ids };
    }
    default:
      throw Errors.badRequest('Unsupported custom field type');
  }
}

export class IntakeFormsService {
  private tasks = new TasksService();
  private customFields = new CustomFieldsService();
  private labels = new LabelsService();

  async list(teamId: string, canManage: boolean): Promise<IntakeFormView[]> {
    const rows = await prisma.intakeForm.findMany({
      where: {
        teamId,
        ...(canManage ? {} : { enabled: true }),
      },
      orderBy: [{ name: 'asc' }],
      include: fieldInclude(),
    });
    return Promise.all(rows.map((r) => toView(r)));
  }

  async get(teamId: string, formId: string): Promise<IntakeFormView> {
    const form = await this.loadForm(teamId, formId);
    return await toView(form);
  }

  async getByPublicToken(token: string): Promise<{ name: string; description: string | null; fields: IntakeFormFieldView[] }> {
    const form = await prisma.intakeForm.findUnique({
      where: { publicToken: token },
      include: fieldInclude(),
    });
    if (!form || !form.enabled || form.mode !== 'PUBLIC') {
      throw Errors.notFound('Form not found');
    }
    const view = await toView(form, true);
    return { name: view.name, description: view.description, fields: view.fields };
  }

  async create(
    teamId: string,
    creatorId: string,
    input: CreateIntakeFormBody,
  ): Promise<IntakeFormView> {
    const mode = input.mode ?? 'TEAM';
    validateFieldDefs(teamId, input.fields, mode);
    await validateCustomFieldsForForm(teamId, input.fields, mode);
    await ensureProjectInTeam(teamId, input.projectId);

    const publicToken = mode === 'PUBLIC' ? generatePublicToken() : null;

    const form = await prisma.intakeForm.create({
      data: {
        teamId,
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? null,
        mode,
        publicToken,
        enabled: input.enabled ?? true,
        createdById: creatorId,
        fields: {
          create: input.fields.map((f) => ({
            label: f.label,
            target: f.target,
            customFieldId: f.target === 'customField' ? f.customFieldId! : null,
            required: f.required ?? false,
            helpText: f.helpText ?? null,
            position: f.position,
          })),
        },
      },
      include: fieldInclude(),
    });
    return await toView(form);
  }

  async update(
    teamId: string,
    formId: string,
    input: UpdateIntakeFormBody,
  ): Promise<IntakeFormView> {
    const existing = await this.loadForm(teamId, formId);
    const mode = input.mode ?? existing.mode;
    const fields = input.fields ?? existing.fields.map((f) => ({
      label: f.label,
      target: f.target as IntakeFormFieldInput['target'],
      customFieldId: f.customFieldId,
      required: f.required,
      helpText: f.helpText,
      position: f.position,
    }));

    validateFieldDefs(teamId, fields, mode);
    await validateCustomFieldsForForm(teamId, fields, mode);

    if (input.projectId) await ensureProjectInTeam(teamId, input.projectId);

    let publicToken = existing.publicToken;
    if (mode === 'PUBLIC' && !publicToken) publicToken = generatePublicToken();
    if (mode === 'TEAM') publicToken = null;

    const form = await prisma.$transaction(async (tx) => {
      await tx.intakeFormField.deleteMany({ where: { formId } });
      return tx.intakeForm.update({
        where: { id: formId },
        data: {
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.mode !== undefined && { mode: input.mode }),
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          publicToken,
          fields: {
            create: fields.map((f) => ({
              label: f.label,
              target: f.target,
              customFieldId: f.target === 'customField' ? f.customFieldId! : null,
              required: f.required ?? false,
              helpText: f.helpText ?? null,
              position: f.position,
            })),
          },
        },
        include: fieldInclude(),
      });
    });
    return await toView(form);
  }

  async remove(teamId: string, formId: string): Promise<void> {
    await this.loadForm(teamId, formId);
    await prisma.intakeForm.delete({ where: { id: formId } });
  }

  async rotatePublicToken(teamId: string, formId: string): Promise<IntakeFormView> {
    const existing = await this.loadForm(teamId, formId);
    if (existing.mode !== 'PUBLIC') {
      throw Errors.badRequest('Token rotation applies only to public forms');
    }
    const form = await prisma.intakeForm.update({
      where: { id: formId },
      data: { publicToken: generatePublicToken() },
      include: fieldInclude(),
    });
    return await toView(form);
  }

  async submitTeam(
    teamId: string,
    formId: string,
    submitterId: string,
    submitterGlobalRole: GlobalRole,
    body: IntakeFormSubmitBody,
  ): Promise<{ taskId: string }> {
    const form = await this.loadForm(teamId, formId);
    if (!form.enabled) throw Errors.badRequest('This form is disabled');
    return this.processSubmission(form, submitterId, submitterGlobalRole, body, false);
  }

  async submitPublic(token: string, body: IntakeFormSubmitBody): Promise<void> {
    if (body.website && body.website.trim().length > 0) {
      return;
    }

    const form = await prisma.intakeForm.findUnique({
      where: { publicToken: token },
      include: fieldInclude(),
    });
    if (!form || !form.enabled || form.mode !== 'PUBLIC') {
      throw Errors.notFound('Form not found');
    }

    const systemUser = await getSystemUser();
    if (!systemUser) throw Errors.internal('System user not configured');

    await ensureSystemManagerOnTeam(form.teamId);
    await this.processSubmission(form, systemUser.id, systemUser.globalRole, body, true);
  }

  private async processSubmission(
    form: FormWithFields,
    actorId: string,
    actorGlobalRole: GlobalRole,
    body: IntakeFormSubmitBody,
    isPublic: boolean,
  ): Promise<{ taskId: string }> {
    const values = body.values ?? {};
    const taskInput: {
      title: string;
      description?: string;
      priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
      dueDate?: string | null;
      assigneeId?: string | null;
    } = { title: '' };

    const customFieldUpdates: { fieldId: string; body: SetTaskCustomFieldValueBody }[] = [];
    const labelIds: string[] = [];

    for (const field of form.fields) {
      const raw = values[field.id];
      const empty =
        raw === null ||
        raw === undefined ||
        raw === '' ||
        (Array.isArray(raw) && raw.length === 0);

      if (field.required && empty) {
        throw Errors.badRequest(`"${field.label}" is required`);
      }
      if (empty) continue;

      switch (field.target) {
        case 'title':
          taskInput.title = asString(raw) ?? '';
          break;
        case 'description':
          taskInput.description = asString(raw) ?? undefined;
          break;
        case 'priority': {
          const p = asString(raw)?.toUpperCase();
          if (!p || !['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(p)) {
            throw Errors.badRequest('Invalid priority value');
          }
          taskInput.priority = p as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
          break;
        }
        case 'dueDate':
          taskInput.dueDate = asString(raw);
          break;
        case 'assignee':
          if (isPublic) throw Errors.badRequest('Assignee is not allowed on public forms');
          taskInput.assigneeId = asString(raw);
          break;
        case 'labels':
          labelIds.push(...asStringArray(raw));
          break;
        case 'customField': {
          if (!field.customField) throw Errors.badRequest('Custom field definition missing');
          if (isPublic && field.customField.type === PERSON_TYPE) {
            throw Errors.badRequest('Person fields are not allowed on public forms');
          }
          customFieldUpdates.push({
            fieldId: field.customFieldId!,
            body: toCustomFieldBody(field.customField.type, raw),
          });
          break;
        }
      }
    }

    if (!taskInput.title.trim()) {
      throw Errors.badRequest('Title is required');
    }

    for (const { fieldId, body: cfBody } of customFieldUpdates) {
      await this.customFields.validateTaskValue(form.teamId, fieldId, cfBody);
    }

    const task = await this.tasks.create(
      form.teamId,
      form.projectId,
      actorId,
      actorGlobalRole,
      taskInput,
      isPublic ? undefined : { intake: true },
    );

    for (const { fieldId, body: cfBody } of customFieldUpdates) {
      await this.customFields.setTaskValue(
        form.teamId,
        form.projectId,
        task.id,
        fieldId,
        actorId,
        cfBody,
      );
    }

    for (const labelId of labelIds) {
      await this.labels.attach(form.teamId, task.id, labelId);
    }

    await logActivity(prisma, {
      actorId: isPublic ? null : actorId,
      teamId: form.teamId,
      taskId: task.id,
      action: 'form.submitted',
      meta: {
        formId: form.id,
        formName: form.name,
        public: isPublic,
      },
    });

    return { taskId: task.id };
  }

  private async loadForm(teamId: string, formId: string): Promise<FormWithFields> {
    const form = await prisma.intakeForm.findUnique({
      where: { id: formId },
      include: fieldInclude(),
    });
    if (!form || form.teamId !== teamId) throw Errors.notFound('Form not found');
    return form;
  }
}

export function publicFormUrl(token: string): string {
  return `/public/forms/${token}`;
}
