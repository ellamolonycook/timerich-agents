import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Run tests against shared *source*, so a build is never a prerequisite
      // and results can never reflect a stale dist/.
      '@timerich/shared': resolvePath('./packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'agents/*/test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'agents/*/src/**/*.ts'],
    },
  },
});
