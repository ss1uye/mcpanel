import { test, expect } from '@playwright/test';
import { ADMIN_PASSWORD, INSTANCE_ROOT } from './helpers';

test('init, onboard, run, back up and restore', async ({ page }) => {
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) cspViolations.push(message.text());
  });
  // The streaming download uses the native save picker, which headless
  // automation cannot drive; force the blob fallback so the download event fires.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined });
  });

  await page.goto('/setup');
  await page.getByLabel('密码', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel('确认密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '创建管理员' }).click();
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/instances');
  await page.getByRole('button', { name: '纳管实例' }).click();
  await page.getByLabel('服务器目录').fill(INSTANCE_ROOT);
  await page.getByRole('button', { name: '检测目录' }).click();
  const startScript = process.platform === 'win32' ? 'start.bat' : 'start.sh';
  await expect(page.getByText(startScript)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '创建实例' }).click();
  await expect(page.getByRole('heading', { name: 'instance' })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '启动' }).click();
  await expect(page.getByText('运行中').first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: '控制台', exact: true }).click();
  await expect(page.getByText(/Starting minecraft server/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('服务器命令').fill('say hello e2e');
  await page.getByLabel('服务器命令').press('Enter');
  await expect(page.getByText(/received say hello e2e/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByText('已停止').first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: '备份', exact: true }).click();
  await page.getByRole('button', { name: '立即备份' }).click();
  await expect(page.getByText('可用')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('备份完成')).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: '恢复' }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByText('恢复完成')).toBeVisible({ timeout: 90_000 });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'instance' })).toBeVisible();

  await page.getByRole('link', { name: '配置', exact: true }).click();
  await page.getByRole('button', { name: '原始编辑' }).click();
  const editor = page.getByLabel('server.properties 内容');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(
    'level-name=world\nserver-port=25620\nenable-rcon=false\nonline-mode=true\nmotd=e2e-edited\n',
  );
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('配置已保存，重启服务器后生效')).toBeVisible({ timeout: 15_000 });

  await page.goto('/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载面板数据库快照' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^panel-.*\.db$/);

  expect(cspViolations).toEqual([]);

  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
