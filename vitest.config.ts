import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'apps/desktop/src/**/*.test.ts'],
    environment: 'node',
  },
});
