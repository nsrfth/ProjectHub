import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { ProjectsExportService, EXPORT_CAP } from '../services/projectsExportService.js';

const svc = new ProjectsExportService();

export async function projectsExportRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/export.xlsx', {
    schema: {
      tags: ['projects'],
      summary: 'Export selected projects to an Excel workbook',
      params: z.object({ teamId: z.string() }),
      body: z.object({
        projectIds: z.array(z.string().min(1)).min(1).max(EXPORT_CAP),
      }),
      response: { 200: z.any() },
      security: [{ bearerAuth: [] }],
    },
    preHandler: [requireAuth, requireTeamRole('MEMBER', 'MANAGER')],
    handler: async (req, reply) => {
      const { teamId } = req.params as { teamId: string };
      const { projectIds } = req.body as { projectIds: string[] };

      const buf = await svc.buildWorkbook(teamId, req.user.sub, req.user.globalRole, projectIds);

      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', 'attachment; filename="projects-export.xlsx"')
        .header('Content-Length', buf.length)
        .send(buf);
    },
  });
}
