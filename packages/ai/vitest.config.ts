import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    // Persist transformed modules on disk so later runs skip re-transforming.
    // Vitest invalidates entries on content/config change, so a stale cache
    // falls back to a fresh transform (fail-closed), never a stale module.
    fsModuleCache: true,
  }
});