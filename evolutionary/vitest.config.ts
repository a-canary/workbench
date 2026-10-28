import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    typecheck: {
      enabled: false,
    },
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});