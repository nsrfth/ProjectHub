import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../data/prisma.js';
import { PERMISSIONS, PERMISSION_GROUPS } from '../lib/permissions.js';
import { passwordPolicyService } from '../services/passwordPolicyService.js';
import { publicPasswordPolicyResponse } from '../schemas/passwordPolicy.js';
import { HolidaysService } from '../services/holidaysService.js';
import { holidayResponse } from '../schemas/holidays.js';
import { readSchedulingSettings } from '../lib/schedulingSettings.js';
import { readReminderSettings } from '../lib/reminderTiming.js';

// Public read-only system metadata. Used by:
//   - The frontend's About button (version + build + license + counts).
//   - The frontend's weekend-aware date picker (`calendar.weekend` setting).
//
// Public on purpose — none of these fields leak per-user or per-team data,
// and forcing auth would mean the login page can't read the weekend
// convention to render its (future) date inputs correctly.
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/info', {
    schema: {
      tags: ['system'],
      summary: 'App version, build info, and a few public instance settings',
      response: {
        200: z.object({
          name: z.string(),
          version: z.string(),
          buildTime: z.string().nullable(),
          nodeEnv: z.string(),
          // Day-of-week ints (0=Sun..6=Sat — JS Date.getUTCDay
          // convention) that the instance treats as off-days. Public so
          // the date picker can colour cells red before login.
          calendarWeekend: z.array(z.number().int().min(0).max(6)),
          // v1.62: instance holidays for off-day rendering (UTC calendar dates).
          calendarHolidays: z.array(
            holidayResponse.pick({ id: true, date: true, name: true, recurring: true }),
          ),
          // v1.18: who can MODIFY (vs add) the due/planned dates on a task.
          //   open         — anyone in the team can edit (default)
          //   manager-only — members can only ADD dates when null;
          //                  modifying a non-null date or clearing it
          //                  requires team MANAGER or global ADMIN
          // Public so the SPA can render the disabled state for everyone.
          dateEditRestriction: z.enum(['open', 'manager-only']),
          // v1.64: opt-in working-day scheduling (off = legacy calendar-day behaviour).
          schedulingRollOffdayDueDates: z.boolean(),
          schedulingWorkingDaysOnly: z.boolean(),
          remindersSkipOffDays: z.boolean(),
          counts: z.object({
            users: z.number().int(),
            teams: z.number().int(),
            tasks: z.number().int(),
          }),
        }),
      },
    },
    handler: async (_req, reply) => {
      // calendar.weekend lives in InstanceSetting (Phase 1 key/Json) as
      // an int[] of weekday IDs. Default [0,6] (Sat+Sun) when unset OR
      // when the stored value is malformed. Wrapped tolerantly so a DB
      // hiccup never breaks the public endpoint.
      let weekend: number[] = [0, 6];
      try {
        const row = await prisma.instanceSetting.findUnique({
          where: { key: 'calendar.weekend' },
        });
        const v = row?.value as unknown;
        if (Array.isArray(v)) {
          const cleaned = v
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
          // De-dupe + sort for stable wire output.
          weekend = [...new Set(cleaned)].sort((a, b) => a - b);
        }
      } catch {
        // Leave default.
      }

      // v1.18: read the date-edit restriction setting tolerantly. Unknown
      // values fall back to "open" (the safe default — preserves pre-v1.18
      // behaviour for any instance that never set this key).
      let dateEditRestriction: 'open' | 'manager-only' = 'open';
      try {
        const row = await prisma.instanceSetting.findUnique({
          where: { key: 'tasks.dateEditRestriction' },
        });
        if (row?.value === 'manager-only') dateEditRestriction = 'manager-only';
      } catch {
        // Leave default.
      }

      const [users, teams, tasks, calendarHolidays, scheduling, reminders] = await Promise.all([
        prisma.user.count().catch(() => 0),
        prisma.team.count().catch(() => 0),
        prisma.task.count().catch(() => 0),
        new HolidaysService().listForBootstrap().catch(() => []),
        readSchedulingSettings().catch(() => ({
          rollOffdayDueDates: false,
          workingDaysOnly: false,
        })),
        readReminderSettings().catch(() => ({ skipOffDays: false })),
      ]);

      return reply.send({
        name: 'TaskHub',
        // Read TASKHUB_VERSION from env; the deploy pipeline can set it
        // from the git tag. Falls back to 'dev' so a local docker compose
        // run reads cleanly. Use || (not ??) so the empty string that
        // docker-compose's `${TASKHUB_VERSION:-}` produces when the key is
        // absent from .env also falls back to 'dev' rather than rendering
        // blank in the About page.
        version: process.env.TASKHUB_VERSION || 'dev',
        buildTime: process.env.TASKHUB_BUILD_TIME || null,
        nodeEnv: process.env.NODE_ENV ?? 'unknown',
        calendarWeekend: weekend,
        calendarHolidays: calendarHolidays.map((h) => ({
          id: h.id,
          date: h.date,
          name: h.name,
          recurring: h.recurring,
        })),
        dateEditRestriction,
        schedulingRollOffdayDueDates: scheduling.rollOffdayDueDates,
        schedulingWorkingDaysOnly: scheduling.workingDaysOnly,
        remindersSkipOffDays: reminders.skipOffDays,
        counts: { users, teams, tasks },
      });
    },
  });

  r.get('/password-policy', {
    schema: {
      tags: ['system'],
      summary: 'Public local-user password policy (for login/change-password UI)',
      response: { 200: publicPasswordPolicyResponse },
    },
    handler: async (_req, reply) => reply.send(await passwordPolicyService.getPublicPolicyView()),
  });

  // v1.23: catalog of permission constants + UI grouping. Auth-less by
  // design (matches the rest of /system) — it's pure code-bound metadata,
  // not per-tenant data. Powers the permission matrix on the roles page.
  r.get('/permissions', {
    schema: {
      tags: ['system'],
      summary: 'List of permission constants the app honours, with UI grouping',
      response: {
        200: z.object({
          permissions: z.array(z.string()),
          groups: z.record(z.string(), z.array(z.string())),
        }),
      },
    },
    handler: async (_req, reply) =>
      reply.send({
        permissions: [...PERMISSIONS],
        groups: Object.fromEntries(
          Object.entries(PERMISSION_GROUPS).map(([k, v]) => [k, [...v]]),
        ),
      }),
  });
}
