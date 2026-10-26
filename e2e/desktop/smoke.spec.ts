import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('desktop shell boots the panel', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: ['.', '--smoke-test'],
    cwd: path.resolve('apps/desktop'),
    env,
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('body')).toContainText(/创建管理员|登录|初始化/, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});
