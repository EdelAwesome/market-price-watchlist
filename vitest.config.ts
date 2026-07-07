import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic unit tests only — no DB/Redis required. Integration tests live under
    // test/integration and run via `npm run test:integration` (needs Postgres).
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
    environment: 'node',
  },
});
