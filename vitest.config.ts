import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@vibe1099\/(shared|db|core)\/(.*)$/,
        replacement: path.resolve(__dirname, 'packages') + '/$1/src/$2',
      },
      { find: '@vibe1099/shared', replacement: path.resolve(__dirname, 'packages/shared/src/index.ts') },
      { find: '@vibe1099/db', replacement: path.resolve(__dirname, 'packages/db/src/index.ts') },
      { find: '@vibe1099/core', replacement: path.resolve(__dirname, 'packages/core/src/index.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
