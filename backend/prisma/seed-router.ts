// Routes `prisma db seed` to one of the demo datasets.
//
//   (default)        minimal seed — admin@taskhub.local / admin
//   SEED_IT_DEMO=1   IT service-desk dataset (~180 tasks)
//   SEED_EPC_DEMO=1  EPC delivery dataset (v2.23.0) — one richly-populated
//                    project exercising nearly every PMIS feature: WBS + a CPM
//                    network with a real critical path, cost control, EVM,
//                    the risk/change/procurement/quality registers, timesheets,
//                    resources and correspondence.
//
// EPC wins if both demo flags are set — it is the fuller dataset, so asking for
// both is almost certainly a request for that one.
const on = (v: string | undefined): boolean => v === '1' || v === 'true';

if (on(process.env.SEED_EPC_DEMO)) {
  await import('./seed-epc-demo.js');
} else if (on(process.env.SEED_IT_DEMO)) {
  await import('./seed-it-demo.js');
} else {
  await import('./seed.js');
}
