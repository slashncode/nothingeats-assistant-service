import { defineConfig } from 'vitest/config';

// Postgres and Valkey run in containers (Testcontainers): the first start pulls images.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 120_000,
    },
});
