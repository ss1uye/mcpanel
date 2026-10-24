import { test, expect } from '@playwright/test';
import { ADMIN_PASSWORD, INSTANCE_ROOT } from './helpers';

test('init, onboard, run, back up and restore', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('密码', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel('确认密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '创建管理员' }).click();
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/instances');
  await page.getByRole('button', { name: '纳管实例' }).click();
  await page.getByLabel('服务器目录').fill(INSTANCE_ROOT);
  await page.getByRole('button', { name: '检测目录' }).click();
  await expect(page.getByText('start.bat')).toBeVisible({ timeout: 15_000 });
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

  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
