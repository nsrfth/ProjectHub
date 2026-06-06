import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Integration tests share one Postgres database and clean it in beforeEach.
    // Running files concurrently would let them wipe each other's state mid-test
    // — leading to spurious FK / unique-constraint failures. Serialize files.
    fileParallelism: false,
  },
});
