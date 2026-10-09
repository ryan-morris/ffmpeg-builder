import { defineConfig } from 'vitest/config';

// CLI tests spawn node and git, which is slow under load: a longer timeout than vitest's 5 s.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 } });
