import { defineConfig } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';

// Tests run against the real local Postgres. Load .env.test (falling back to .env.local) so
// DATABASE_URL/TEST_DATABASE_URL are present without requiring a shell export.
function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1]) out[match[1]] = match[2] ?? '';
  }
  return out;
}

const fileEnv = {
  ...loadEnvFile(path.resolve(__dirname, '.env.local')),
  ...loadEnvFile(path.resolve(__dirname, '.env.test')),
};

export default defineConfig({
  // The receipt component is a .tsx with no `import React` (Next uses the automatic JSX runtime).
  // Vitest's esbuild defaults to the classic runtime, so set it to automatic to render the receipt
  // in a test the same way the app does.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/support/setup.ts'],
    env: fileEnv,
    // Integration tests run against a real local Postgres started with `supabase start`.
    // Concurrency tests need real parallel connections, so run files sequentially.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
