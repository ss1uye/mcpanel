import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/desktop',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});
