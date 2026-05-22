import { PrismaClient } from '@prisma/client';

// Single shared client. Fastify lifecycle hooks close it on shutdown.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
