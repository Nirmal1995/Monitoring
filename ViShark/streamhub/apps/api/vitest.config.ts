import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        // Needs the local infrastructure (pnpm infra:up) and MONGO_URL from .env.
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 30_000,
          // Test files share one test database and Redis DB: run them one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
