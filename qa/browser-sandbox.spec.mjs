import { test, expect } from '@playwright/test';

const baseUrl = String(process.env.ASSET_MANAGER_E2E_URL || '').replace(/\/$/, '');

async function isAssetManagerFrame(frame) {
  try {
    if (frame === frame.page().mainFrame()) return false;
    const hasTitle = await frame.getByText('Asset Manager', { exact: true }).count();
    const hasInternalNav = await frame.getByText('Configuration', { exact: true }).count();
    return Boolean(hasTitle && hasInternalNav);
  } catch {
    return false;
  }
}

async function waitForAppFrame(page) {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (await isAssetManagerFrame(frame)) return frame.url() || 'found';
    }
    return '';
  }, { timeout: 30_000 }).not.toBe('');

  for (const frame of page.frames()) {
    if (await isAssetManagerFrame(frame)) return frame;
  }
  throw new Error('Asset Manager iframe did not render.');
}

async function assertAppHealthy(frame) {
  const body = await frame.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(30);
  expect(body).not.toContain('Asset Manager could not load');
  expect(body).not.toContain('locationMapping is not defined');
  expect(body).not.toContain('There was an error invoking the function - Limits for the current installation have been exceeded');
}

async function clickInternalNav(page, name) {
  let frame = await waitForAppFrame(page);
  const target = frame.getByText(name, { exact: true });
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
  await target.first().click();
  await page.waitForTimeout(700);
  frame = await waitForAppFrame(page);
  await assertAppHealthy(frame);
  return frame;
}

test.describe('Asset Manager sandbox browser acceptance', () => {
  test.skip(!baseUrl, 'ASSET_MANAGER_E2E_URL is not configured.');

  test('overview and internal navigation render without runtime errors', async ({ page }) => {
    await page.goto(`${baseUrl}/overview`, { waitUntil: 'domcontentloaded' });
    let frame = await waitForAppFrame(page);
    await assertAppHealthy(frame);

    for (const section of ['Assets', 'Imports', 'Configuration']) {
      frame = await clickInternalNav(page, section);
      const body = await frame.locator('body').innerText();
      expect(body).toContain(section === 'Imports' ? 'Import' : section);
    }
  });

  test('reports route renders without Forge/runtime failure', async ({ page }) => {
    await page.goto(`${baseUrl}/reports`, { waitUntil: 'domcontentloaded' });
    const frame = await waitForAppFrame(page);
    await assertAppHealthy(frame);
    const body = await frame.locator('body').innerText();
    expect(body.toLowerCase()).toContain('report');
  });
});
