import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HolidaysController } from '../controllers/holidaysController.js';
import { HolidaysService } from '../services/holidaysService.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  createHolidayBody,
  holidayResponse,
  importHolidayBody,
  importPreviewResponse,
  importResultResponse,
  updateHolidayBody,
} from '../schemas/holidays.js';

// v1.62: instance-wide holiday calendar. Reads for any authenticated user;
// mutations require global ADMIN (same gate as instance settings).
export async function holidaysRoutes(app: FastifyInstance): Promise<void> {
  const svc = new HolidaysService();
  const ctrl = new HolidaysController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);

  r.get('/', {
    schema: {
      tags: ['holidays'],
      summary: 'List instance holidays (optional year or from/to filter)',
      querystring: z.object({
        year: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
      response: { 200: z.array(holidayResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/range', {
    schema: {
      tags: ['holidays'],
      summary: 'List holidays in a date span (inclusive UTC calendar dates)',
      querystring: z.object({
        from: z.string().datetime(),
        to: z.string().datetime(),
      }),
      response: { 200: z.array(holidayResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listRange,
  });

  r.register(async (admin) => {
    admin.addHook('preHandler', requireGlobalAdmin);
    admin.addHook('preHandler', requireScope('admin'));

    admin.get('/import/preview', {
      schema: {
        tags: ['holidays'],
        summary: 'Preview Iranian holiday dataset import (admin, no writes)',
        querystring: z.object({
          jalaliYear: z.string(),
        }),
        response: { 200: importPreviewResponse },
        security: [{ bearerAuth: [] }],
      },
      handler: ctrl.previewImport,
    });

    admin.post('/import', {
      schema: {
        tags: ['holidays'],
        summary: 'Import Iranian holidays from bundled offline dataset (admin)',
        body: importHolidayBody,
        response: { 200: importResultResponse },
        security: [{ bearerAuth: [] }],
      },
      handler: ctrl.importFromDataset,
    });

    admin.post('/', {
      schema: {
        tags: ['holidays'],
        summary: 'Create an instance holiday (admin)',
        body: createHolidayBody,
        response: { 201: holidayResponse },
        security: [{ bearerAuth: [] }],
      },
      handler: ctrl.create,
    });

    admin.patch('/:id', {
      schema: {
        tags: ['holidays'],
        summary: 'Update an instance holiday (admin)',
        params: z.object({ id: z.string() }),
        body: updateHolidayBody,
        response: { 200: holidayResponse },
        security: [{ bearerAuth: [] }],
      },
      handler: ctrl.update,
    });

    admin.delete('/:id', {
      schema: {
        tags: ['holidays'],
        summary: 'Delete an instance holiday (admin)',
        params: z.object({ id: z.string() }),
        security: [{ bearerAuth: [] }],
      },
      handler: ctrl.remove,
    });
  });
}
