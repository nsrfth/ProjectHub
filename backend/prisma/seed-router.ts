// Routes `prisma db seed` to the IT demo seed or the legacy demo seed.
const useItDemo = process.env.SEED_IT_DEMO === '1' || process.env.SEED_IT_DEMO === 'true';

if (useItDemo) {
  await import('./seed-it-demo.js');
} else {
  await import('./seed.js');
}
