import { defineConfig } from 'vitest/config';

// Integration tests hit a REAL Postgres (DATABASE_URL). Run with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false, // integration tests share one DB; run files serially
    testTimeout: 15000,
  },
});
